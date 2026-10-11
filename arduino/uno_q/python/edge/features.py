"""Log-mel front-end, a NumPy port of ``acoustic_models.features.LogMel``.

The parameters and every numeric detail (periodic Hann window, reflect padding,
HTK mel scale, per-filter L1 normalization, centred frame cropping) mirror the
PyTorch module used at training time, so a model trained there can run here
without changing the feature stage. ``tools/check_parity.py`` verifies this
against the PyTorch reference.
"""

from __future__ import annotations

import numpy as np

_EPS = 1e-6


def hz_to_mel(freq: np.ndarray | float) -> np.ndarray | float:
    return 2595.0 * np.log10(1.0 + np.asarray(freq) / 700.0)


def mel_to_hz(mel: np.ndarray | float) -> np.ndarray | float:
    return 700.0 * (10.0 ** (np.asarray(mel) / 2595.0) - 1.0)


def mel_filterbank(
    n_mels: int,
    n_fft: int,
    sample_rate: int,
    f_min: float = 0.0,
    f_max: float | None = None,
) -> np.ndarray:
    """Return an ``(n_mels, n_fft // 2 + 1)`` triangular mel filterbank (HTK mel)."""
    if f_max is None:
        f_max = sample_rate / 2.0

    n_freqs = n_fft // 2 + 1
    fft_freqs = np.linspace(0.0, sample_rate / 2.0, n_freqs)

    mel_points = np.linspace(
        float(hz_to_mel(f_min)), float(hz_to_mel(f_max)), n_mels + 2
    )
    hz_points = np.asarray(mel_to_hz(mel_points))

    fb = np.zeros((n_mels, n_freqs), dtype=np.float64)
    for i in range(n_mels):
        left, center, right = hz_points[i], hz_points[i + 1], hz_points[i + 2]
        up = (fft_freqs - left) / max(center - left, 1e-8)
        down = (right - fft_freqs) / max(right - center, 1e-8)
        fb[i] = np.clip(np.minimum(up, down), 0.0, None)

    fb = fb / np.maximum(fb.sum(axis=1, keepdims=True), 1e-8)
    return fb


class LogMel:
    """Waveform -> log-mel spectrogram.

    Input:  ``(T,)`` or ``(B, T)`` float waveform.
    Output: ``(B, 1, n_mels, frames)`` float32 with ``frames == target_frames``.
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
        eps: float = _EPS,
    ) -> None:
        self.sample_rate = sample_rate
        self.n_fft = n_fft
        self.win_length = win_length
        self.hop_length = hop_length
        self.n_mels = n_mels
        self.target_frames = target_frames
        self.eps = eps

        n = np.arange(win_length)
        window = 0.5 - 0.5 * np.cos(2.0 * np.pi * n / win_length)  # torch periodic Hann
        if win_length < n_fft:  # torch zero-pads a short window to n_fft (centred)
            pad = (n_fft - win_length) // 2
            window = np.pad(window, (pad, n_fft - win_length - pad))
        self.window = window.astype(np.float64)
        self.mel_fb = mel_filterbank(n_mels, n_fft, sample_rate, f_min, f_max)

    def _fix_frames(self, logmel: np.ndarray) -> np.ndarray:
        """Center-crop or right-pad the frame axis to ``target_frames`` (matches torch)."""
        frames = logmel.shape[-1]
        if frames == self.target_frames:
            return logmel
        if frames > self.target_frames:
            start = (frames - self.target_frames) // 2
            return logmel[..., start : start + self.target_frames]
        pad = self.target_frames - frames
        return np.pad(logmel, ((0, 0), (0, 0), (0, pad)), constant_values=np.log(self.eps))

    def _stft_power(self, wave: np.ndarray) -> np.ndarray:
        """``(T,)`` waveform -> ``(frames, n_freqs)`` power spectrum."""
        pad = self.n_fft // 2
        x = np.pad(wave, (pad, pad), mode="reflect")
        n_frames = 1 + (len(x) - self.n_fft) // self.hop_length
        idx = (
            np.arange(self.n_fft)[None, :]
            + self.hop_length * np.arange(n_frames)[:, None]
        )
        frames = x[idx] * self.window  # (n_frames, n_fft)
        spec = np.fft.rfft(frames, n=self.n_fft, axis=1)
        return np.abs(spec) ** 2

    def __call__(self, waveform: np.ndarray) -> np.ndarray:
        waveform = np.asarray(waveform, dtype=np.float64)
        if waveform.ndim == 1:
            waveform = waveform[None, :]
        if waveform.ndim != 2:
            raise ValueError(f"expected (B, T) waveform, got shape {waveform.shape}")

        out = np.empty((waveform.shape[0], 1, self.n_mels, self.target_frames), dtype=np.float32)
        for b in range(waveform.shape[0]):
            power = self._stft_power(waveform[b])  # (frames, n_freqs)
            mel = power @ self.mel_fb.T  # (frames, n_mels)
            logmel = np.log(mel + self.eps).T  # (n_mels, frames)
            out[b, 0] = self._fix_frames(logmel[None, :, :])[0]
        return out
