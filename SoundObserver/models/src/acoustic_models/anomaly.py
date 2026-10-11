"""Unsupervised "normal" models (normal-only anomalous sound detection).

These learn what is *normal* for a zone from unlabeled local audio, then score
novelty -- no anomaly labels required. Three methods, from cheapest to richest:

- :class:`RollingStats`      -- online mean/variance, seconds to warm up
- :class:`KNNFeatureBank`    -- distance to a bank of normal embeddings
- :class:`TinyAutoencoder`   -- reconstruction error, trained on normal only

See ``docs/audio-classification-model.md`` section 4.1.
"""

from __future__ import annotations

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


class RollingStats:
    """Per-feature running mean/variance with an online (Welford) update.

    Score is the mean squared z-score of a feature vector against the running
    statistics: 0 means "typical", larger means "unusual".
    """

    def __init__(self, n_features: int, eps: float = 1e-6) -> None:
        self.n_features = int(n_features)
        self.eps = eps
        self.mean_ = np.zeros(self.n_features, dtype=np.float64)
        self.m2_ = np.zeros(self.n_features, dtype=np.float64)
        self.count_ = 0

    def update(self, x: np.ndarray) -> "RollingStats":
        x = np.asarray(x, dtype=np.float64).reshape(-1)
        if x.size != self.n_features:
            raise ValueError(f"expected {self.n_features} features, got {x.size}")
        self.count_ += 1
        delta = x - self.mean_
        self.mean_ += delta / self.count_
        self.m2_ += delta * (x - self.mean_)
        return self

    def partial_fit(self, X: np.ndarray) -> "RollingStats":
        for x in np.atleast_2d(X):
            self.update(x)
        return self

    @property
    def var_(self) -> np.ndarray:
        if self.count_ < 2:
            return np.ones(self.n_features, dtype=np.float64)
        return self.m2_ / (self.count_ - 1)

    def score(self, x: np.ndarray) -> float:
        x = np.asarray(x, dtype=np.float64).reshape(-1)
        z = (x - self.mean_) / np.sqrt(self.var_ + self.eps)
        return float(np.mean(z**2))


class KNNFeatureBank:
    """Store normal embeddings; novelty is the mean distance to the k nearest."""

    def __init__(self, k: int = 5) -> None:
        self.k = int(k)
        self.bank: np.ndarray | None = None

    def fit(self, embeddings: np.ndarray) -> "KNNFeatureBank":
        self.bank = np.asarray(embeddings, dtype=np.float64).reshape(len(embeddings), -1)
        return self

    def add(self, embedding: np.ndarray) -> "KNNFeatureBank":
        e = np.asarray(embedding, dtype=np.float64).reshape(1, -1)
        self.bank = e if self.bank is None else np.vstack([self.bank, e])
        return self

    def score(self, embedding: np.ndarray) -> float:
        if self.bank is None or len(self.bank) == 0:
            raise RuntimeError("feature bank is empty; call fit() first")
        e = np.asarray(embedding, dtype=np.float64).reshape(-1)
        dists = np.linalg.norm(self.bank - e, axis=1)
        k = min(self.k, len(dists))
        return float(np.sort(dists)[:k].mean())


class TinyAutoencoder(nn.Module):
    """Small convolutional autoencoder over log-mel; novelty = reconstruction error."""

    def __init__(self, n_mels: int = 40) -> None:
        super().__init__()
        self.n_mels = n_mels
        self.encoder = nn.Sequential(
            nn.Conv2d(1, 8, 3, padding=1),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),
            nn.Conv2d(8, 16, 3, padding=1),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),
            nn.Conv2d(16, 16, 3, padding=1),
            nn.ReLU(inplace=True),
        )
        self.decoder = nn.Sequential(
            nn.Upsample(scale_factor=2, mode="nearest"),
            nn.Conv2d(16, 8, 3, padding=1),
            nn.ReLU(inplace=True),
            nn.Upsample(scale_factor=2, mode="nearest"),
            nn.Conv2d(8, 1, 3, padding=1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        z = self.encoder(x)
        rec = self.decoder(z)
        if rec.shape[-2:] != x.shape[-2:]:
            rec = F.interpolate(rec, size=x.shape[-2:], mode="nearest")
        return rec

    def reconstruction_error(self, x: torch.Tensor) -> torch.Tensor:
        """Per-sample reconstruction MSE, shape ``(B,)``."""
        with torch.no_grad():
            rec = self.forward(x)
        return ((rec - x) ** 2).mean(dim=(1, 2, 3))

    def num_parameters(self) -> int:
        return sum(p.numel() for p in self.parameters() if p.requires_grad)
