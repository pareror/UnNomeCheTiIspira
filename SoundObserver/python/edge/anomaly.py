"""Unsupervised "normal" baseline: rolling statistics over the model embedding.

A NumPy port of ``acoustic_models.anomaly.RollingStats`` (the "free", instant
warm-up method from docs/audio-classification-model.md section 4.1). It learns
what is *normal* for this zone from unlabeled local audio; novelty is the mean
squared z-score of a feature vector against the running statistics.

The raw score is unbounded, so :meth:`novelty` squashes it into a 0..1 signal
that the decision logic can threshold (``score / (1 + score)``, monotonic with
0.5 at one standard deviation on average).
"""

from __future__ import annotations

import numpy as np


class RollingStats:
    """Per-feature running mean/variance with an online (Welford) update."""

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

    @property
    def var_(self) -> np.ndarray:
        if self.count_ < 2:
            return np.ones(self.n_features, dtype=np.float64)
        return self.m2_ / (self.count_ - 1)

    def score(self, x: np.ndarray) -> float:
        """Mean squared z-score: 0 means "typical", larger means "unusual"."""
        x = np.asarray(x, dtype=np.float64).reshape(-1)
        z = (x - self.mean_) / np.sqrt(self.var_ + self.eps)
        return float(np.mean(z**2))

    @property
    def ready(self) -> bool:
        return self.count_ >= 2

    def novelty(self, x: np.ndarray) -> float:
        """Bounded 0..1 novelty for the decision logic (``score / (1 + score)``)."""
        if not self.ready:
            self.update(x)
            return 0.0
        s = self.score(x)
        return float(s / (1.0 + s))
