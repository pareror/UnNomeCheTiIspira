"""Standalone acoustic AI: a waveform in, the dominant class out.

This module bundles *only* the three stages that turn audio into a label:

    preprocess (DC block + low-cut) -> log-mel (40x49) -> DS-CNN (ONNX/TFLite)

It deliberately leaves out everything the full runtime adds on top -- the novelty
baseline, the hysteresis/decision logic, the LED and the server reporter -- so it
can be imported and called from anywhere with a single call:

    from edge.classifier import classify

    label, confidence = classify(window)          # (T,) float waveform @ 16 kHz
    label, confidence = classify_file("clip.wav") # read + resample + first window

For repeated calls, keep an :class:`AcousticClassifier` instance instead of the
module-level helpers (which cache one default instance internally).

Run it directly on a clip:

    python SoundObserver/python/edge/classifier.py SoundObserver/test_sounds/scream.wav
"""

from __future__ import annotations

import os
import sys

if __package__ in (None, ""):  # allow `python .../edge/classifier.py` (no package context)
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pathlib import Path
from typing import NamedTuple

import numpy as np

from edge.audio import _read_wav, _resample
from edge.config import RuntimeConfig
from edge.engine import ModelRunner
from edge.features import LogMel
from edge.preprocess import Preprocessor


class Prediction(NamedTuple):
    """The one thing this module returns: the dominant class and its confidence.

    Unpacks like a tuple (``label, confidence = prediction``) and also exposes
    the two fields by name.
    """

    label: str
    confidence: float


class AcousticClassifier:
    """Loads the model once and classifies windows on demand.

    Parameters mirror the runtime conditioning so the standalone result matches
    what the edge node reports:

    - ``model_dir`` / ``model_file``: model bundle location (default: ``model/``,
      auto-detecting ``model_int8.onnx`` | ``model.onnx`` | ``model.tflite``).
    - ``sample_rate``: rate the windows are expected at (Hz).
    - ``highpass_hz``: low-cut before log-mel (``0`` disables); matches the
      runtime default so live audio is not skewed toward the low-frequency class.
    - ``peak_normalize``: optional per-window peak normalization.
    """

    def __init__(
        self,
        model_dir: str | os.PathLike | None = None,
        model_file: str | None = None,
        sample_rate: int = 16000,
        highpass_hz: float = 100.0,
        peak_normalize: bool = False,
    ) -> None:
        cfg = RuntimeConfig()
        if model_dir is not None:
            cfg.model_dir = Path(model_dir)
        if model_file is not None:
            cfg.model_file = model_file
        cfg.sample_rate = sample_rate

        self._runner = ModelRunner.from_dir(cfg.resolve_model())
        self._meta = self._runner.meta
        self._sample_rate = sample_rate
        self._win_samples = int(round(self._meta.win_seconds * sample_rate))
        self._logmel = LogMel(
            sample_rate=sample_rate,
            n_mels=self._meta.n_mels,
            target_frames=self._meta.frames,
        )
        self._preprocess = Preprocessor(sample_rate, highpass_hz, peak_normalize)

    @property
    def labels(self) -> list[str]:
        """Class names the model can output (in output order)."""
        return list(self._meta.class_names)

    def classify(self, window: np.ndarray) -> Prediction:
        """Classify one audio window and return the dominant class + confidence.

        ``window`` is a 1-D float waveform at the configured sample rate; a clip
        that is not exactly one model window is cropped/padded frame-wise by the
        log-mel stage, so any length works.
        """
        feat = self._logmel(self._preprocess(np.asarray(window, dtype=np.float32)))
        result = self._runner.infer(feat)
        return Prediction(self._meta.class_names[result.urban_index], result.urban_confidence)

    def classify_file(self, path: str | os.PathLike) -> Prediction:
        """Read a WAV file (resampled to the model rate) and classify its first window."""
        sr, data = _read_wav(str(path))
        data = _resample(data, sr, self._sample_rate)
        if data.size < self._win_samples:
            data = np.pad(data, (0, self._win_samples - data.size))
        return self.classify(data[: self._win_samples])


_DEFAULT: AcousticClassifier | None = None


def _default() -> AcousticClassifier:
    global _DEFAULT
    if _DEFAULT is None:
        _DEFAULT = AcousticClassifier()
    return _DEFAULT


def classify(window: np.ndarray, **kwargs) -> Prediction:
    """Classify ``window`` with a cached default classifier (see :meth:`AcousticClassifier.classify`)."""
    clf = _default() if not kwargs else AcousticClassifier(**kwargs)
    return clf.classify(window)


def classify_file(path: str | os.PathLike, **kwargs) -> Prediction:
    """Classify a WAV file with a cached default classifier (see :meth:`AcousticClassifier.classify_file`)."""
    clf = _default() if not kwargs else AcousticClassifier(**kwargs)
    return clf.classify_file(path)


def _main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Classify a WAV clip: print the dominant class and confidence.")
    parser.add_argument("wav", help="path to a 16 kHz (or any rate) WAV file")
    parser.add_argument("--model-dir", default=None)
    parser.add_argument("--model-file", default=None)
    parser.add_argument("--highpass", type=float, default=100.0, help="low-cut Hz before log-mel (default 100, 0 disables)")
    args = parser.parse_args(argv)

    clf = AcousticClassifier(
        model_dir=args.model_dir, model_file=args.model_file, highpass_hz=args.highpass
    )
    label, confidence = clf.classify_file(args.wav)
    print(f"{label}\t{confidence:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
