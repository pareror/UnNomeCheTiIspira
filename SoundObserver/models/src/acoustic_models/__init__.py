"""TinyML models for the urban acoustic sensor network.

Two model families, both designed to fit a sub-7-EUR MCU:

- :mod:`acoustic_models.ds_cnn`  -- tiny DS-CNN classifier (urban-noise + safety heads)
- :mod:`acoustic_models.anomaly` -- unsupervised "normal" detectors (rolling stats, kNN bank, tiny autoencoder)

See ``docs/audio-classification-model.md`` for the full specification.
"""

from acoustic_models.ds_cnn import DSCNN
from acoustic_models.features import LogMel

__all__ = ["DSCNN", "LogMel"]
