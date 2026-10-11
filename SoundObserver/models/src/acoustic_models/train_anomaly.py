"""Train the tiny autoencoder on normal-only audio (unsupervised ASD).

The autoencoder learns to reconstruct the zone's *normal* log-mel; at runtime,
reconstruction error is the novelty score (see docs section 4.1).

Examples
--------
Smoke test (random "normal" data, no dataset needed):
    uv run python -m acoustic_models.train_anomaly --smoke
"""

from __future__ import annotations

import argparse

import torch

from acoustic_models.anomaly import TinyAutoencoder
from acoustic_models.features import LogMel


def train_smoke(steps: int = 5, batch: int = 8, lr: float = 1e-3, seed: int = 0) -> None:
    """Train the autoencoder on random normal data to exercise the path."""
    torch.manual_seed(seed)
    device = "cpu"
    logmel = LogMel().to(device)
    model = TinyAutoencoder(n_mels=40).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)

    print(f"model parameters: {model.num_parameters()}")
    for step in range(steps):
        wave = torch.randn(batch, 16000, device=device)
        feats = logmel(wave)
        rec = model(feats)
        loss = torch.mean((rec - feats) ** 2)

        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
        print(f"step {step + 1}/{steps}  recon_mse={loss.item():.5f}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--smoke", action="store_true", help="run on random data")
    parser.add_argument("--steps", type=int, default=5)
    parser.add_argument("--out", default="artifacts/anomaly_ae.pt")
    args = parser.parse_args()

    if args.smoke:
        train_smoke(steps=args.steps)
        return

    raise SystemExit(
        "Provide normal-only audio for the target zone, or run with --smoke. "
        "See docs/audio-classification-model.md section 4.1."
    )


if __name__ == "__main__":
    main()
