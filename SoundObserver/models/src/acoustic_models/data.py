"""Dataset and audio-loading helpers for training."""

from __future__ import annotations

from typing import Sequence

import numpy as np
import torch
from scipy.io import wavfile
from scipy.signal import resample_poly
from torch.utils.data import Dataset

from acoustic_models.features import LogMel


def _read_audio(path: str) -> tuple[int, np.ndarray]:
    """Read any supported audio file to mono float32.

    Prefers libsndfile (handles PCM, float, ADPCM, ...); falls back to scipy for
    the plain PCM/float WAVs it supports.
    """
    try:
        import soundfile as sf

        data, sr = sf.read(path, dtype="float32", always_2d=False)
        return int(sr), np.asarray(data, dtype=np.float32)
    except Exception:
        sr, data = wavfile.read(path)
        return int(sr), np.asarray(data, dtype=np.float32)


def load_waveform(path: str, sample_rate: int = 16000) -> torch.Tensor:
    """Load a mono waveform, resampled to ``sample_rate`` and peak-normalized."""
    sr, data = _read_audio(path)
    if data.ndim > 1:
        data = data.mean(axis=1)
    peak = float(np.abs(data).max()) if data.size else 0.0
    if peak > 0:
        data = data / peak
    if sr != sample_rate:
        data = resample_poly(data, sample_rate, sr).astype(np.float32)
    return torch.from_numpy(data)


class LogMelDataset(Dataset):
    """Items are ``(wav_path, urban_label, safety_label)`` -> ``(feat, urban, safety)``."""

    def __init__(
        self,
        items: Sequence[tuple[str, int, int]],
        sample_rate: int = 16000,
        logmel: LogMel | None = None,
    ) -> None:
        self.items = list(items)
        self.sample_rate = sample_rate
        self.logmel = logmel or LogMel(sample_rate=sample_rate)

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, index: int):
        path, urban_label, safety_label = self.items[index]
        waveform = load_waveform(path, self.sample_rate)
        feat = self.logmel(waveform)[0]  # (1, n_mels, frames)
        return feat, int(urban_label), float(safety_label)
