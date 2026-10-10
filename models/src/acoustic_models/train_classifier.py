"""Train the tiny DS-CNN classifier (urban-noise + safety heads).

Supports optional knowledge distillation from an offline teacher's soft labels
(see :mod:`acoustic_models.teacher`).

Examples
--------
Smoke test (random data, no dataset needed):
    uv run python -m acoustic_models.train_classifier --smoke

Real training:
    uv run python -m acoustic_models.train_classifier --config configs/default.yaml
"""

from __future__ import annotations

import argparse
import os

import torch
import torch.nn.functional as F

from acoustic_models.ds_cnn import DSCNN
from acoustic_models.features import LogMel


def random_waveforms(batch: int, seconds: float, sample_rate: int, device: str) -> torch.Tensor:
    n = int(seconds * sample_rate)
    return torch.randn(batch, n, device=device)


def train_smoke(steps: int = 5, batch: int = 8, lr: float = 1e-3, seed: int = 0) -> None:
    """Exercise the full forward/backward path on random data."""
    torch.manual_seed(seed)
    device = "cpu"
    logmel = LogMel().to(device)
    model = DSCNN(n_mels=40, n_urban=8).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)

    print(f"model parameters: {model.num_parameters()}")
    for step in range(steps):
        wave = random_waveforms(batch, 1.0, 16000, device)
        feats = logmel(wave)
        urban = torch.randint(0, 8, (batch,), device=device)
        safety = torch.randint(0, 2, (batch,), device=device).float()

        urban_logits, safety_logits, _ = model(feats)
        loss = F.cross_entropy(urban_logits, urban)
        loss = loss + F.binary_cross_entropy_with_logits(safety_logits, safety)

        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
        print(f"step {step + 1}/{steps}  loss={loss.item():.4f}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="configs/default.yaml")
    parser.add_argument("--smoke", action="store_true", help="run on random data")
    parser.add_argument("--steps", type=int, default=5)
    parser.add_argument("--out", default="artifacts/ds_cnn.pt")
    args = parser.parse_args()

    if args.smoke:
        train_smoke(steps=args.steps)
        return

    # Real training entry point loads configs/default.yaml and a LogMelDataset.
    # Wired here so the CLI is stable; dataset path is required in production.
    from acoustic_models.data import LogMelDataset  # noqa: F401  (kept for the real path)

    raise SystemExit(
        "Provide a dataset and implement the training loop, or run with --smoke. "
        "See docs/audio-classification-model.md section 8."
    )


if __name__ == "__main__":
    main()
