"""16 kHz windowed audio sources for the runtime loop.

Two sources are provided:

- :class:`WavSource`  -- replays a WAV file (looping), for offline/desktop tests.
- :class:`MicSource`  -- captures from a USB microphone / sound card via the Linux
  ``sounddevice`` (PortAudio) backend.

Both return fixed-length, peak-normalized 1 s windows, matching the loader used
at training time (``acoustic_models.data.load_waveform``).
"""

from __future__ import annotations

import threading
import wave
from pathlib import Path

import numpy as np

from edge.config import RuntimeConfig


def _resample(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    if sr_in == sr_out:
        return x.astype(np.float32)
    try:
        from scipy.signal import resample_poly

        return resample_poly(x, sr_out, sr_in).astype(np.float32)
    except ImportError:
        n_out = int(round(len(x) * sr_out / sr_in))
        return np.interp(
            np.linspace(0.0, len(x) - 1, n_out), np.arange(len(x)), x
        ).astype(np.float32)


def _read_wav(path: str) -> tuple[int, np.ndarray]:
    """Read a PCM/float WAV to mono float32 using only the standard library."""
    with wave.open(str(path), "rb") as fh:
        sr = fh.getframerate()
        channels = fh.getnchannels()
        width = fh.getsampwidth()
        raw = fh.readframes(fh.getnframes())
    dtype = {1: np.uint8, 2: np.int16, 4: np.int32}[width]
    data = np.frombuffer(raw, dtype=dtype)
    if width == 1:
        data = (data.astype(np.float32) - 128.0) / 128.0
    else:
        data = data.astype(np.float32) / float(np.iinfo(dtype).max)
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    return sr, data.astype(np.float32)


class WavSource:
    """Loop a WAV file, emitting overlapping windows at the configured hop."""

    def __init__(self, cfg: RuntimeConfig) -> None:
        if not cfg.wav_path:
            raise ValueError("source='wav' requires a wav_path")
        sr, data = _read_wav(cfg.wav_path)
        peak = float(np.abs(data).max()) if data.size else 0.0
        if peak > 0:
            data = data / peak
        self.data = _resample(data, sr, cfg.sample_rate)
        self.win = cfg.win_samples
        self.hop = cfg.hop_samples
        self.pos = 0

    def read_window(self) -> np.ndarray:
        if len(self.data) < self.win:  # very short clip: zero-pad, as at training time
            return np.pad(self.data, (0, self.win - len(self.data)))
        start = self.pos % max(1, len(self.data) - self.win + 1)
        self.pos = (start + self.hop) % max(1, len(self.data) - self.win + 1)
        return self.data[start : start + self.win]


class MicSource:
    """Capture from a sound device; :meth:`read_window` returns the last 1 s."""

    def __init__(self, cfg: RuntimeConfig) -> None:
        import sounddevice as sd  # imported lazily so wav-only runs need no PortAudio

        self.win = cfg.win_samples
        self.hop = cfg.hop_samples
        self._buf = np.zeros(max(self.win, self.hop) * 4, dtype=np.float32)
        self._filled = 0
        self._lock = threading.Lock()

        def callback(indata, frames, _time, _status):  # noqa: ANN001
            mono = indata[:, 0] if indata.ndim > 1 else indata
            with self._lock:
                n = len(mono)
                if n >= len(self._buf):
                    self._buf[:] = mono[-len(self._buf):]
                    self._filled = len(self._buf)
                else:
                    self._buf = np.roll(self._buf, -n)
                    self._buf[-n:] = mono
                    self._filled = min(self._filled + n, len(self._buf))

        self.stream = sd.InputStream(
            samplerate=cfg.sample_rate,
            channels=1,
            dtype="float32",
            blocksize=max(self.hop, 256),
            device=cfg.device,
            callback=callback,
        )
        self.stream.start()

    def read_window(self) -> np.ndarray:
        # Wait until at least one hop of fresh audio has arrived.
        while True:
            with self._lock:
                if self._filled >= self.win:
                    window = self._buf[-self.win :].copy()
                    self._filled = self.win - self.hop
                    return window
            threading.Event().wait(0.02)

    def close(self) -> None:
        self.stream.stop()
        self.stream.close()


def make_source(cfg: RuntimeConfig):
    if cfg.source == "mic":
        return MicSource(cfg)
    if cfg.source == "wav":
        return WavSource(cfg)
    raise ValueError(f"unknown source: {cfg.source!r} (expected 'wav' or 'mic')")


def rms_dbfs(window: np.ndarray) -> float:
    """Amplitude in dBFS (0 = full scale); the node's 1 Hz telemetry value."""
    rms = float(np.sqrt(np.mean(np.square(window)) + 1e-12))
    return float(20.0 * np.log10(max(rms, 1e-6)))
