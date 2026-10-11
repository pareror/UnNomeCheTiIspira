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

    paces_itself = False  # returns immediately; the caller paces the loop

    def __init__(self, cfg: RuntimeConfig) -> None:
        if not cfg.wav_path:
            raise ValueError("source='wav' requires a wav_path")
        sr, data = _read_wav(cfg.wav_path)
        # No level normalization here: the runtime (like a live mic) sees raw
        # levels, so the silence gate and dBFS reflect the file as-is.
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


def _pick_input_rate(sd, cfg: RuntimeConfig) -> int:
    """Return a sample rate the input device accepts (prefer the model's)."""
    wanted = cfg.sample_rate
    try:
        sd.check_input_settings(device=cfg.device, samplerate=wanted, channels=1, dtype="float32")
        return wanted
    except Exception:  # noqa: BLE001 - many ALSA devices refuse 16 kHz directly
        info = sd.query_devices(cfg.device) if cfg.device is not None else sd.query_devices(kind="input")
        rate = int(round(float(info["default_samplerate"])))
        print(f"[edge] input device does not accept {wanted} Hz; opening at {rate} Hz and resampling")
        return rate


class MicSource:
    """Capture from a sound device; :meth:`read_window` returns the last window.

    The stream is opened at a rate the device accepts (falling back to its
    default and resampling), and each window is returned at the model's sample
    rate as a fixed-length array.
    """

    paces_itself = True  # read_window blocks until fresh audio has arrived

    def __init__(self, cfg: RuntimeConfig) -> None:
        import sounddevice as sd  # imported lazily so wav-only runs need no PortAudio

        self.out_samples = cfg.win_samples
        self.target_rate = cfg.sample_rate
        win_seconds = cfg.win_samples / cfg.sample_rate
        hop_seconds = cfg.hop_samples / cfg.sample_rate
        self.capture_rate = _pick_input_rate(sd, cfg)
        self.cap_win = max(1, int(round(win_seconds * self.capture_rate)))
        self.cap_hop = max(1, int(round(hop_seconds * self.capture_rate)))
        self._buf = np.zeros(self.cap_win * 4, dtype=np.float32)
        self._filled = 0
        self._lock = threading.Lock()
        self._status: str | None = None

        def callback(indata, frames, _time, status):  # noqa: ANN001
            if status:
                self._status = str(status)
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
            samplerate=self.capture_rate,
            channels=1,
            dtype="float32",
            blocksize=0,
            device=cfg.device,
            callback=callback,
        )
        self.stream.start()

    def read_window(self) -> np.ndarray:
        # Wait until at least one hop of fresh audio has arrived.
        while True:
            with self._lock:
                if self._filled >= self.cap_win:
                    chunk = self._buf[-self.cap_win :].copy()
                    self._filled = max(0, self.cap_win - self.cap_hop)
                    break
            threading.Event().wait(0.02)

        if self._status:  # overflow/underflow reported by PortAudio
            print(f"[edge] audio input warning: {self._status}")
            self._status = None

        if self.capture_rate != self.target_rate:
            chunk = _resample(chunk, self.capture_rate, self.target_rate)
        if chunk.size != self.out_samples:
            chunk = chunk[: self.out_samples] if chunk.size > self.out_samples else np.pad(
                chunk, (0, self.out_samples - chunk.size)
            )
        return chunk

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


class BackgroundGate:
    """Treat a window as background/idle when it sits near the running noise floor.

    Real microphones in a quiet room deliver low-level noise the classifier was
    never trained on (it has no "background" class), and it forces it onto some
    label. Accepting a window only when it rises clearly above the ambient floor
    keeps the node idle until there is an actual sound event.

    The floor is tracked with a leaky-minimum: it drops instantly to quieter
    windows and rises slowly, so steady background stays below the threshold while
    a real event (well above the floor) is still classified.
    """

    def __init__(
        self,
        floor_dbfs: float = -50.0,
        margin_db: float = 8.0,
        rise_db_per_hop: float = 0.2,
    ) -> None:
        self.floor_dbfs = floor_dbfs
        self.margin_db = margin_db
        self.rise = rise_db_per_hop
        self.floor: float | None = None

    def update(self, dbfs: float) -> bool:
        """Return ``True`` if the window should be treated as background/idle."""
        if dbfs < self.floor_dbfs:
            return True
        if self.floor is None:
            self.floor = dbfs
        elif dbfs < self.floor:
            self.floor = dbfs
        else:
            self.floor += min(dbfs - self.floor, self.rise)
        if self.margin_db <= 0:
            return False
        return dbfs < self.floor + self.margin_db
