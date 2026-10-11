"""Prepare the trained DS-CNN for the UNO Q runtime.

Reads the training checkpoint (``acoustic_models.train_classifier.train_real``),
which carries the normalization statistics and class names that the ONNX graph
does *not* include, and writes the deployable bundle consumed by the app:

    model/model.onnx          (or --onnx to reuse an existing export)
    model/model_int8.onnx     (with --int8, static INT8 quantization)
    model/model_meta.json     class names, norm_mean/std, frames, embedding_dim

Run it in the models environment (needs torch + onnx):

    python SoundObserver/tools/prepare_model.py \
        --checkpoint SoundObserver/models/artifacts/ds_cnn_urban_safety.pt \
        --out SoundObserver/model

Add ``--int8 --calib-cache SoundObserver/models/data/urban_safety_features.pt`` to also emit a
full-integer model (matches the TFLite INT8 target in docs/model spec section 7).
``tools/check_parity.py`` verifies the NumPy front-end against PyTorch.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import torch

THIS = Path(__file__).resolve()
APP_ROOT = THIS.parents[1]
MODELS_SRC = APP_ROOT / "models" / "src"
sys.path.insert(0, str(MODELS_SRC))

from acoustic_models.export import N_MELS, export_classifier_onnx  # noqa: E402

KIND = "ds_cnn_classifier"


def read_checkpoint(path: Path) -> dict:
    ckpt = torch.load(path, map_location="cpu", weights_only=False)
    if not isinstance(ckpt, dict):
        raise ValueError(f"{path} is a bare state_dict, not a training checkpoint")
    state = ckpt.get("model_state_dict", ckpt)
    urban_weight = state["urban_head.weight"]
    return {
        "class_names": list(ckpt["class_names"]),
        "n_urban": int(ckpt.get("n_urban", urban_weight.shape[0])),
        "embedding_dim": int(urban_weight.shape[1]),
        "frames": int(ckpt.get("frames", 49)),
        "n_mels": N_MELS,
        "win_seconds": float(ckpt.get("win_seconds", 1.0)),
        "norm_mean": float(ckpt["norm_mean"]),
        "norm_std": float(ckpt["norm_std"]),
        "version": str(ckpt.get("best_epoch", 0)),
        "params": int(ckpt.get("params", 0)),
    }


def copy_onnx(src: Path, out_dir: Path, model_name: str) -> Path:
    """Copy an ONNX (and its external ``.data`` sibling, if any) into out_dir."""
    dest = out_dir / model_name
    shutil.copyfile(src, dest)
    external = src.with_name(src.name + ".data")
    if external.exists():
        shutil.copyfile(external, dest.with_name(dest.name + ".data"))
    return dest


def quantize_int8(src: Path, dest: Path, meta: dict, calib_cache: Path | None, n: int) -> None:
    from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_static

    class FeatReader(CalibrationDataReader):
        def __init__(self) -> None:
            self.batches = build_calibration(meta, calib_cache, n)
            self.it = iter(self.batches)

        def get_next(self):  # noqa: ANN201
            b = next(self.it, None)
            return None if b is None else {"logmel": b}

    quantize_static(
        model_input=str(src),
        model_output=str(dest),
        calibration_data_reader=FeatReader(),
        quant_format=QuantFormat.QDQ,
        activation_type=QuantType.QInt8,
        weight_type=QuantType.QInt8,
    )


def build_calibration(meta: dict, cache: Path | None, limit: int):
    import numpy as np

    frames = meta["frames"]
    if cache and cache.exists():
        blob = torch.load(cache, map_location="cpu", weights_only=False)
        X = blob["X"].float().numpy()
        print(f"calibrating from {cache} ({X.shape[0]} windows)")
    else:
        print("calibrating on random data (pass --calib-cache for a real dataset)")
        X = np.random.randn(limit, 1, meta["n_mels"], frames).astype(np.float32)
    X = X[:limit]
    X = (X - meta["norm_mean"]) / (meta["norm_std"] + 1e-5)
    return [X[i : i + 1].astype(np.float32) for i in range(len(X))]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True, help="trained .pt checkpoint")
    parser.add_argument("--out", default="SoundObserver/model", help="output model directory")
    parser.add_argument("--onnx", default=None, help="reuse an existing .onnx instead of re-exporting")
    parser.add_argument("--name", default="model.onnx", help="output onnx filename")
    parser.add_argument("--int8", action="store_true", help="also write a statically quantized INT8 model")
    parser.add_argument("--calib-cache", default="SoundObserver/models/data/urban_safety_features.pt")
    parser.add_argument("--calib-samples", type=int, default=200)
    args = parser.parse_args()

    ckpt_path = Path(args.checkpoint)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    meta = read_checkpoint(ckpt_path)
    print(f"checkpoint: {ckpt_path.name}  classes={meta['n_urban']}  frames={meta['frames']}  "
          f"params={meta['params']}")

    if args.onnx:
        onnx_path = copy_onnx(Path(args.onnx), out_dir, args.name)
        print(f"reused ONNX -> {onnx_path}")
    else:
        onnx_path = out_dir / args.name
        export_classifier_onnx(
            str(onnx_path),
            n_urban=meta["n_urban"],
            frames=meta["frames"],
            weights_path=str(ckpt_path),
        )

    meta_path = out_dir / "model_meta.json"
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"wrote {meta_path}")

    if args.int8:
        cache = Path(args.calib_cache)
        int8_path = out_dir / "model_int8.onnx"
        quantize_int8(onnx_path, int8_path, meta, cache, args.calib_samples)
        print(f"wrote {int8_path} ({int8_path.stat().st_size / 1024:.1f} KB)")

    print(f"\n[OK] deployable bundle in {out_dir} (kind={KIND})")


if __name__ == "__main__":
    main()
