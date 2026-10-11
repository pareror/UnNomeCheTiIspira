"""Tiny DS-CNN audio classifier.

A depthwise-separable CNN over log-mel features, reused from the TinyML
reference architectures (MLPerf Tiny keyword spotting, ESC-50 tinyML CNN).
It shares one convolutional trunk and exposes a compact embedding plus two
heads:

- ``urban``  -- multi-class softmax over the urban-noise taxonomy
- ``safety`` -- binary logit for scream / cry-for-help

The embedding is also used by the anomaly detectors (kNN bank / autoencoder).
"""

from __future__ import annotations

import torch
import torch.nn as nn


class DSConv(nn.Module):
    """Depthwise-separable convolution block: depthwise -> pointwise -> BN -> ReLU."""

    def __init__(self, c_in: int, c_out: int, kernel_size: int = 3, stride: int = 1) -> None:
        super().__init__()
        padding = kernel_size // 2
        self.depthwise = nn.Conv2d(
            c_in, c_in, kernel_size, stride, padding, groups=c_in, bias=False
        )
        self.pointwise = nn.Conv2d(c_in, c_out, 1, bias=False)
        self.bn = nn.BatchNorm2d(c_out)
        self.act = nn.ReLU(inplace=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.act(self.bn(self.pointwise(self.depthwise(x))))


class DSCNN(nn.Module):
    """DS-CNN classifier with a shared trunk and two heads.

    Input:  ``(B, 1, n_mels, frames)`` log-mel.
    Output: tuple ``(urban_logits, safety_logits, embedding)``.
    """

    def __init__(
        self,
        n_mels: int = 40,
        n_urban: int = 8,
        dropout: float = 0.2,
        embedding_dim: int = 64,
    ) -> None:
        super().__init__()
        self.n_mels = n_mels
        self.n_urban = n_urban

        self.stem = nn.Sequential(
            nn.Conv2d(1, 32, 3, padding=1, bias=False),
            nn.BatchNorm2d(32),
            nn.ReLU(inplace=True),
        )
        self.blocks = nn.Sequential(
            nn.Sequential(DSConv(32, 32), nn.MaxPool2d(2), nn.Dropout(dropout)),
            nn.Sequential(DSConv(32, 64), nn.MaxPool2d(2), nn.Dropout(dropout)),
            nn.Sequential(DSConv(64, 64), nn.MaxPool2d(2), nn.Dropout(dropout)),
        )
        self.pool = nn.AdaptiveAvgPool2d(1)
        self.trunk = nn.Sequential(
            nn.Flatten(),
            nn.Linear(64, embedding_dim),
            nn.ReLU(inplace=True),
        )
        self.urban_head = nn.Linear(embedding_dim, n_urban)
        self.safety_head = nn.Linear(embedding_dim, 1)

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        x = self.stem(x)
        x = self.blocks(x)
        x = self.pool(x)
        embedding = self.trunk(x)
        urban_logits = self.urban_head(embedding)
        safety_logits = self.safety_head(embedding).squeeze(-1)
        return urban_logits, safety_logits, embedding

    def num_parameters(self) -> int:
        return sum(p.numel() for p in self.parameters() if p.requires_grad)
