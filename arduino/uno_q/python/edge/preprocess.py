"""Input conditioning that matches the training front-end.

The model was trained on clean, band-limited, **peak-normalized** recordings
(``acoustic_models.data.load_waveform``). A raw microphone adds DC offset and
low-frequency rumble/hum that the model never saw; because the classifier is
sensitive to low-frequency energy, that contamination dominates the decision
(rumble/hum collapse to the "traffic"/engine class and mask higher-frequency
events like a scream).

This stage removes DC and sub-band rumble (high-pass) and peak-normalizes each
window, bringing live audio back onto the training distribution. Offline clips
are already clean, so the stage is safe (and near-idempotent) there too.
"""

from __future__ import annotations

import numpy as np


class Preprocessor:
    """DC block -> high-pass -> peak normalize.

    Uses a zero-phase 2nd-order Butterworth high-pass when SciPy is available
    (the ``resample`` extra) and a vectorized moving-average high-pass otherwise.
    """

    def __init__(
        self,
        sample_rate: int = 16000,
        highpass_hz: float = 100.0,
        peak_normalize: bool = False,
        silence_floor: float = 1e-4,
    ) -> None:
        self.sample_rate = sample_rate
        self.highpass_hz = float(highpass_hz)
        self.peak_normalize = peak_normalize
        self.silence_floor = silence_floor
        self._sos = self._design()

    def _design(self):
        if self.highpass_hz <= 0:
            return None
        try:
            from scipy.signal import butter

            return butter(2, self.highpass_hz / (self.sample_rate / 2), btype="highpass", output="sos")
        except Exception:  # noqa: BLE001 - scipy is optional
            return None

    def _highpass(self, x: np.ndarray) -> np.ndarray:
        if self.highpass_hz <= 0:
            return x
        if self._sos is not None:
            from scipy.signal import sosfilt

            return sosfilt(self._sos, x)
        # Dependency-free fallback: subtract a moving average (nulls DC, tilts bass).
        k = max(1, int(round(self.sample_rate / self.highpass_hz)))
        if x.size <= k:
            return x - x.mean()
        c = np.cumsum(np.insert(x, 0, 0.0))
        ma = (c[k:] - c[:-k]) / k
        low = np.empty_like(x)
        low[: ma.size] = ma
        low[ma.size :] = ma[-1] if ma.size else 0.0
        return x - low

    def __call__(self, window: np.ndarray) -> np.ndarray:
        x = np.asarray(window, dtype=np.float64)
        x = x - x.mean()  # DC block
        x = self._highpass(x)
        if self.peak_normalize:
            peak = float(np.abs(x).max())
            if peak > self.silence_floor:
                x = x * (1.0 / peak)
        return x.astype(np.float32)
