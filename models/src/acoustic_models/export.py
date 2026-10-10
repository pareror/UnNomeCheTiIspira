"""Export trained models for on-MCU deployment (ONNX -> TFLite INT8).

PyTorch has no first-party TFLite exporter, so the path is:

    PyTorch  --torch.onnx.export-->  ONNX  --ai-edge-torch or onnx2tf-->  TFLite
                                             (INT8, full-integer)

This module performs the ONNX step and prints the exact follow-up commands.

Example:
    uv run python -m acoustic_models.export --out artifacts/
"""

from __future__ import annotations

import argparse
import os
import sys

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import torch

from acoustic_models.anomaly import TinyAutoencoder
from acoustic_models.ds_cnn import DSCNN

N_MELS = 40
FRAMES = 49


def _onnx_export(model, dummy, path: str, input_names: list[str], output_names: list[str]) -> None:
    """Export a fixed batch-1 model to ONNX (opset 18).

    A fixed input shape keeps the graph MCU-friendly. The legacy exporter is
    used only as a fallback when the dynamo exporter is unavailable.
    """
    try:
        torch.onnx.export(
            model,
            dummy,
            path,
            input_names=input_names,
            output_names=output_names,
            opset_version=18,
        )
    except (ImportError, ModuleNotFoundError):
        torch.onnx.export(
            model,
            dummy,
            path,
            input_names=input_names,
            output_names=output_names,
            opset_version=17,
            dynamic_axes={input_names[0]: {0: "batch"}},
            dynamo=False,
        )


def export_classifier_onnx(path: str, n_urban: int = 8, weights_path: str | None = None) -> None:
    model = DSCNN(n_mels=N_MELS, n_urban=n_urban)
    if weights_path is not None and os.path.exists(weights_path):
        ckpt = torch.load(weights_path, map_location="cpu", weights_only=False)
        state_dict = ckpt.get("model_state_dict", ckpt) if isinstance(ckpt, dict) else ckpt
        model.load_state_dict(state_dict)
        print(f"loaded weights from {weights_path}")
    model.eval()
    dummy = torch.randn(1, 1, N_MELS, FRAMES)
    _onnx_export(
        model,
        dummy,
        path,
        input_names=["logmel"],
        output_names=["urban_logits", "safety_logit", "embedding"],
    )
    print(f"wrote {path}")


def export_anomaly_onnx(path: str) -> None:
    model = TinyAutoencoder(n_mels=N_MELS).eval()
    dummy = torch.randn(1, 1, N_MELS, FRAMES)
    _onnx_export(
        model,
        dummy,
        path,
        input_names=["logmel"],
        output_names=["reconstruction"],
    )
    print(f"wrote {path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="artifacts")
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)

    export_classifier_onnx(os.path.join(args.out, "ds_cnn.onnx"))
    export_anomaly_onnx(os.path.join(args.out, "anomaly_ae.onnx"))

    print(
        "\nNext steps for TFLite INT8 (run in an environment with the tools installed):\n"
        "  # option A (Google): PyTorch -> TFLite via ai-edge-torch\n"
        "  uv run --with ai-edge-torch python -c "
        "\"import ai_edge_torch; ...\"  # see ai-edge-torch docs\n"
        "  # option B: ONNX -> TFLite via onnx2tf / onnx-tf\n"
        "  uvx --from onnx2tf onnx2tf -i artifacts/ds_cnn.onnx -o artifacts/tflite/\n"
        "\nThen quantize to full-integer INT8 with a representative log-mel dataset "
        "and check the tensor arena fits the target MCU (see docs section 7)."
    )


if __name__ == "__main__":
    main()
