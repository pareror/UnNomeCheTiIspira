"""Log-mel front-end, matching the on-MCU feature extraction.

The parameters mirror the on-device pipeline (16 kHz mono, 1 s window ->
~40 mel x ~49 frames) so a model trained here can be ported to TFLite Micro
without changing the feature stage.
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F


def hz_to_mel(freq: torch.Tensor) -> torch.Tensor:
    return 2595.0 * torch.log10(1.0 + freq / 700.0)


def mel_to_hz(mel: torch.Tensor) -> torch.Tensor:
    return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)


def mel_filterbank(
    n_mels: int,
    n_fft: int,
    sample_rate: int,
    f_min: float = 0.0,
    f_max: float | None = None,
) -> torch.Tensor:
    """Return an ``(n_mels, n_fft // 2 + 1)`` triangular mel filterbank (HTK mel)."""
    if f_max is None:
        f_max = sample_rate / 2.0

    n_freqs = n_fft // 2 + 1
    fft_freqs = torch.linspace(0.0, sample_rate / 2.0, n_freqs)

    mel_points = torch.linspace(
        float(hz_to_mel(torch.tensor(f_min))),
        float(hz_to_mel(torch.tensor(f_max))),
        n_mels + 2,
    )
    hz_points = mel_to_hz(mel_points)

    fb = torch.zeros(n_mels, n_freqs)
    for i in range(n_mels):
        left, center, right = hz_points[i], hz_points[i + 1], hz_points[i + 2]
        up = (fft_freqs - left) / (center - left).clamp(min=1e-8)
        down = (right - fft_freqs) / (right - center).clamp(min=1e-8)
        fb[i] = torch.clamp(torch.minimum(up, down), min=0.0)

    fb = fb / fb.sum(dim=1, keepdim=True).clamp(min=1e-8)
    return fb


class LogMel(nn.Module):
    """Waveform -> log-mel spectrogram.

    Input:  ``(B, T)`` or ``(T,)`` float waveform.
    Output: ``(B, 1, n_mels, frames)`` with ``frames == target_frames``.
    """

    def __init__(
        self,
        sample_rate: int = 16000,
        n_fft: int = 512,
        win_length: int = 400,
        hop_length: int = 320,
        n_mels: int = 40,
        f_min: float = 0.0,
        f_max: float | None = None,
        target_frames: int = 49,
        eps: float = 1e-6,
    ) -> None:
        super().__init__()
        self.sample_rate = sample_rate
        self.n_fft = n_fft
        self.win_length = win_length
        self.hop_length = hop_length
        self.n_mels = n_mels
        self.target_frames = target_frames
        self.eps = eps

        self.register_buffer("window", torch.hann_window(win_length))
        self.register_buffer(
            "mel_fb", mel_filterbank(n_mels, n_fft, sample_rate, f_min, f_max)
        )

    def _fix_frames(self, logmel: torch.Tensor) -> torch.Tensor:
        frames = logmel.shape[-1]
        if frames == self.target_frames:
            return logmel
        if frames > self.target_frames:
            start = (frames - self.target_frames) // 2
            return logmel[..., start : start + self.target_frames]
        pad = self.target_frames - frames
        return F.pad(logmel, (0, pad), value=float(torch.log(torch.tensor(self.eps))))

    def forward(self, waveform: torch.Tensor) -> torch.Tensor:
        if waveform.dim() == 1:
            waveform = waveform.unsqueeze(0)
        if waveform.dim() != 2:
            raise ValueError(f"expected (B, T) waveform, got shape {tuple(waveform.shape)}")

        spec = torch.stft(
            waveform,
            n_fft=self.n_fft,
            hop_length=self.hop_length,
            win_length=self.win_length,
            window=self.window,
            center=True,
            return_complex=True,
        )
        power = spec.abs() ** 2  # (B, n_freqs, frames)
        mel = torch.einsum("mf,bft->bmt", self.mel_fb, power)
        logmel = torch.log(mel + self.eps)
        logmel = self._fix_frames(logmel)
        return logmel.unsqueeze(1)  # (B, 1, n_mels, frames)
