"""On-device runtime for the urban acoustic sensor (Arduino UNO Q, Linux side).

This package is a NumPy/ONNX-runtime port of the reference pipeline in
``SoundObserver/models/src/acoustic_models`` so it runs on the Qualcomm QRB2210 without torch:

- :mod:`edge.features`  -- log-mel front-end (matches ``acoustic_models.features.LogMel``)
- :mod:`edge.engine`    -- ONNX / TFLite DS-CNN runner + model metadata
- :mod:`edge.anomaly`   -- unsupervised "normal" baseline (rolling statistics)
- :mod:`edge.decision`  -- hysteresis / smoothing -> LED state + event flags
- :mod:`edge.audio`     -- 16 kHz windowed audio sources (WAV replay / USB mic)
"""

from __future__ import annotations

__all__ = ["features", "engine", "anomaly", "decision", "audio", "config"]
