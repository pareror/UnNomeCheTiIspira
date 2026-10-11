"""DS-CNN inference for the UNO Q Linux side.

Loads the exported classifier (ONNX by default, TFLite if you ship an INT8
``.tflite``) plus the ``model_meta.json`` written by ``tools/prepare_model.py``,
which carries the normalization statistics and class names that PyTorch held at
training time but the ONNX graph does not.

Contract (from ``acoustic_models.ds_cnn.DSCNN`` / ``export.py``):

    input  "logmel"        float32 (1, 1, n_mels, frames), already normalized
    outputs "urban_logits" (1, n_urban)
            "safety_logit" (1,)      -> sigmoid = scream / gunshot probability
            "embedding"    (1, 64)   -> used by the anomaly detector
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class ModelMeta:
    class_names: list[str]
    norm_mean: float
    norm_std: float
    frames: int
    n_mels: int
    win_seconds: float
    embedding_dim: int = 64
    version: str = "0"

    @property
    def n_urban(self) -> int:
        return len(self.class_names)

    @classmethod
    def load(cls, path: Path) -> "ModelMeta":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls(
            class_names=list(data["class_names"]),
            norm_mean=float(data.get("norm_mean", 0.0)),
            norm_std=float(data.get("norm_std", 1.0)),
            frames=int(data.get("frames", 49)),
            n_mels=int(data.get("n_mels", 40)),
            win_seconds=float(data.get("win_seconds", 1.0)),
            embedding_dim=int(data.get("embedding_dim", 64)),
            version=str(data.get("version", "0")),
        )


@dataclass
class Inference:
    urban_probs: np.ndarray
    urban_index: int
    urban_confidence: float
    safety_prob: float
    embedding: np.ndarray


def _softmax(x: np.ndarray) -> np.ndarray:
    x = x - np.max(x)
    e = np.exp(x)
    return e / np.sum(e)


def _sigmoid(x: float) -> float:
    return float(1.0 / (1.0 + np.exp(-x)))


class _OnnxBackend:
    def __init__(self, path: Path) -> None:
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.intra_op_num_threads = 2
        self.session = ort.InferenceSession(
            str(path), sess_options=so, providers=["CPUExecutionProvider"]
        )
        self.input_name = self.session.get_inputs()[0].name
        self.output_index = {o.name: i for i, o in enumerate(self.session.get_outputs())}

    def run(self, feat: np.ndarray) -> list[np.ndarray]:
        return self.session.run(None, {self.input_name: feat.astype(np.float32)})


class _TfliteBackend:
    def __init__(self, path: Path) -> None:
        try:
            from tflite_runtime.interpreter import Interpreter
        except ImportError:  # newer LiteRT package
            from ai_edge_litert.interpreter import Interpreter

        self.interpreter = Interpreter(model_path=str(path))
        self.interpreter.allocate_tensors()
        self.input = self.interpreter.get_input_details()[0]
        self.outputs = self.interpreter.get_output_details()

    def run(self, feat: np.ndarray) -> list[np.ndarray]:
        self.interpreter.set_tensor(self.input["index"], feat.astype(self.input["dtype"]))
        self.interpreter.invoke()
        return [self.interpreter.get_tensor(o["index"]) for o in self.outputs]


class ModelRunner:
    """Loads a model once and exposes a single :meth:`infer` call."""

    def __init__(self, model_path: Path, meta: ModelMeta) -> None:
        self.meta = meta
        model_path = Path(model_path)
        if model_path.suffix == ".tflite":
            self.backend = _TfliteBackend(model_path)
        elif model_path.suffix == ".onnx":
            self.backend = _OnnxBackend(model_path)
        else:
            raise ValueError(f"unsupported model format: {model_path.suffix}")

    @classmethod
    def from_dir(cls, model_path: Path, meta_path: Path | None = None) -> "ModelRunner":
        model_path = Path(model_path)
        meta_path = meta_path or model_path.with_name("model_meta.json")
        meta = ModelMeta.load(meta_path)
        return cls(model_path, meta)

    def _pick(self, outputs: list[np.ndarray]) -> tuple[np.ndarray, float, np.ndarray]:
        idx = getattr(self.backend, "output_index", None)
        names = [o["name"] for o in getattr(self.backend, "outputs", [])]
        if idx:
            order = {name: idx.get(name) for name in idx}
        else:
            order = {}
            for name in ("urban_logits", "safety_logit", "embedding"):
                order[name] = names.index(name) if name in names else None

        def get(name: str, fallback: int) -> np.ndarray:
            i = order.get(name)
            return np.asarray(outputs[fallback if i is None else i]).reshape(-1)

        urban = get("urban_logits", 0)
        safety = float(get("safety_logit", 1)[0])
        embedding = get("embedding", 2)
        return urban, safety, embedding

    def infer(self, feat: np.ndarray) -> Inference:
        """``feat`` is the raw log-mel ``(1, 1, n_mels, frames)`` (pre-normalization)."""
        normalized = (feat - self.meta.norm_mean) / (self.meta.norm_std + 1e-5)
        urban_logits, safety_logit, embedding = self._pick(self.backend.run(normalized))
        probs = _softmax(urban_logits)
        index = int(np.argmax(probs))
        return Inference(
            urban_probs=probs,
            urban_index=index,
            urban_confidence=float(probs[index]),
            safety_prob=_sigmoid(safety_logit),
            embedding=embedding,
        )
