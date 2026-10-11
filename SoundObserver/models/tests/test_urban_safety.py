import tempfile
import numpy as np
import scipy.io.wavfile as wavfile
import torch

from acoustic_models import urban_safety
from acoustic_models.features import LogMel


def test_urban_safety_taxonomy():
    assert len(urban_safety.CLASS_NAMES) == 9
    assert "scream" in urban_safety.CLASS_NAMES
    assert "gunshot" in urban_safety.CLASS_NAMES
    assert "speech" in urban_safety.CLASS_NAMES
    assert "traffic" in urban_safety.CLASS_NAMES

    assert urban_safety.group_of("scream") == urban_safety.ANOMALOUS_GROUP
    assert urban_safety.group_of("gunshot") == urban_safety.ANOMALOUS_GROUP
    assert urban_safety.group_of("traffic") == urban_safety.NORMAL_GROUP
    assert urban_safety.group_of("speech") == urban_safety.NORMAL_GROUP
    assert urban_safety.group_of("ambient_quiet") == urban_safety.NORMAL_GROUP

    assert urban_safety.safety_of("scream") == 1.0
    assert urban_safety.safety_of("gunshot") == 1.0
    assert urban_safety.safety_of("traffic") == 0.0
    assert urban_safety.safety_of("speech") == 0.0


def test_urban_safety_feature_building():
    # Create temporary synthetic wav file
    sr = 16000
    synth = np.sin(2 * np.pi * 440 * np.linspace(0, 1.5, int(1.5 * sr))).astype(np.float32)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        wav_path = tf.name
    try:
        wavfile.write(wav_path, sr, synth)
        clip = urban_safety.Clip(
            filename="test_scream.wav",
            path=wav_path,
            target=0,
            class_name="scream",
            fold=1,
            safety_label=1.0,
        )
        logmel = LogMel(sample_rate=sr)
        feats = urban_safety.build_features([clip], logmel=logmel, verbose=False)

        assert feats["X"].ndim == 4
        assert feats["X"].shape[1:] == (1, 40, 49)
        assert feats["y"][0] == 0
        assert feats["safety"][0] == 1.0
        assert feats["class_name"][0] == "scream"
    finally:
        import os

        if os.path.exists(wav_path):
            os.remove(wav_path)


def test_urban_safety_disjoint_splits():
    rng = np.random.default_rng(42)
    # 100 clips, 4 windows per clip
    clip_ids = np.repeat(np.arange(100), 4)
    folds = np.repeat(rng.integers(1, 11, size=100), 4)

    dummy_blob = {
        "clip_id": clip_ids,
        "fold": folds,
    }

    res = urban_safety.verify_disjoint_splits(dummy_blob, test_fold=10, val_frac=0.1)
    assert res["is_disjoint"] is True
    assert res["overlap_train_val"] == 0
    assert res["overlap_train_test"] == 0
    assert res["overlap_val_test"] == 0

