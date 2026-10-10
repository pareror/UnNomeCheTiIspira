"""UrbanSound8K dataset loading, label taxonomy and feature building.

UrbanSound8K (Salamon et al., 2014) is 8732 labelled urban sound slices (<= 4 s),
10 classes, split into 10 folds. License: CC BY-NC 3.0 (non-commercial).

The 10 classes map closely to the project's urban taxonomy. For the anomaly
task we split them into:

- **normal**    -- everyday ambient (air_conditioner, children_playing, dog_bark, street_music)
- **anomalous** -- noise / alerts (car_horn, drilling, engine_idling, gun_shot, jackhammer, siren)
"""

from __future__ import annotations

import csv
import os
import tarfile
import urllib.request
from dataclasses import dataclass

import numpy as np
import torch

from acoustic_models.data import load_waveform
from acoustic_models.features import LogMel

US8K_URL = "https://zenodo.org/record/1203745/files/UrbanSound8K.tar.gz"

CLASS_NAMES = [
    "air_conditioner",
    "car_horn",
    "children_playing",
    "dog_bark",
    "drilling",
    "engine_idling",
    "gun_shot",
    "jackhammer",
    "siren",
    "street_music",
]

NORMAL_CLASSES = {"air_conditioner", "children_playing", "dog_bark", "street_music"}
ANOMALOUS_CLASSES = {"car_horn", "drilling", "engine_idling", "gun_shot", "jackhammer", "siren"}
NORMAL_GROUP = "normal"
ANOMALOUS_GROUP = "anomalous"


def group_of(class_name: str) -> str:
    if class_name in NORMAL_CLASSES:
        return NORMAL_GROUP
    if class_name in ANOMALOUS_CLASSES:
        return ANOMALOUS_GROUP
    return "other"


@dataclass(frozen=True)
class Clip:
    filename: str
    path: str
    target: int
    class_name: str
    fold: int


def download(root: str, url: str = US8K_URL) -> str:
    if _find_csv(root) is not None:
        return root
    os.makedirs(root, exist_ok=True)
    tar_path = os.path.join(root, "urbansound8k.tar.gz")
    if not os.path.exists(tar_path):
        print(f"downloading UrbanSound8K -> {tar_path} (~6 GB)")
        urllib.request.urlretrieve(url, tar_path)
    print("extracting ...")
    with tarfile.open(tar_path) as tf:
        tf.extractall(root)
    return root


def _find_csv(root: str) -> str | None:
    direct = os.path.join(root, "UrbanSound8K", "metadata", "UrbanSound8K.csv")
    if os.path.exists(direct):
        return direct
    for dirpath, _dirs, files in os.walk(root):
        if "UrbanSound8K.csv" in files:
            return os.path.join(dirpath, "UrbanSound8K.csv")
    return None


def load_clips(root: str) -> list[Clip]:
    csv_path = _find_csv(root)
    if csv_path is None:
        raise FileNotFoundError(f"UrbanSound8K.csv not found under {root}")
    base = os.path.dirname(os.path.dirname(csv_path))  # .../UrbanSound8K
    clips: list[Clip] = []
    with open(csv_path, newline="") as fh:
        for row in csv.DictReader(fh):
            fold = int(row["fold"])
            clips.append(
                Clip(
                    filename=row["slice_file_name"],
                    path=os.path.join(base, "audio", f"fold{fold}", row["slice_file_name"]),
                    target=int(row["classID"]),
                    class_name=row["class"],
                    fold=fold,
                )
            )
    if not clips:
        raise RuntimeError("no UrbanSound8K clips found")
    return clips


def class_names_by_target(clips: list[Clip]) -> list[str]:
    names = [""] * (max(c.target for c in clips) + 1)
    for clip in clips:
        names[clip.target] = clip.class_name
    return names


def build_features(
    clips: list[Clip],
    win_seconds: float = 1.0,
    hop_seconds: float = 1.0,
    sample_rate: int = 16000,
    logmel: LogMel | None = None,
    verbose: bool = True,
) -> dict:
    """Split each clip into 1 s windows (pad if shorter) and compute log-mel."""
    logmel = logmel or LogMel(sample_rate=sample_rate)
    win = int(win_seconds * sample_rate)
    hop = int(hop_seconds * sample_rate)

    feats, labels, folds, clip_ids, class_names = [], [], [], [], []
    for clip_id, clip in enumerate(clips):
        wave = load_waveform(clip.path, sample_rate)
        if wave.shape[0] < win:
            wave = torch.nn.functional.pad(wave, (0, win - wave.shape[0]))
            starts = [0]
        else:
            starts = list(range(0, wave.shape[0] - win + 1, hop))
        for start in starts:
            window = wave[start : start + win]
            with torch.no_grad():
                feat = logmel(window)[0]
            feats.append(feat)
            labels.append(clip.target)
            folds.append(clip.fold)
            clip_ids.append(clip_id)
            class_names.append(clip.class_name)
        if verbose and (clip_id + 1) % 2000 == 0:
            print(f"  featurized {clip_id + 1}/{len(clips)} clips")

    if not feats:
        raise RuntimeError("no windows produced")
    return {
        "X": torch.stack(feats),
        "y": np.asarray(labels),
        "fold": np.asarray(folds),
        "clip_id": np.asarray(clip_ids),
        "class_name": np.asarray(class_names),
        "group": np.asarray([group_of(c) for c in class_names]),
    }


def build_blob(root: str) -> dict:
    """Load + featurize, returning the blob expected by the experiments runner."""
    clips = load_clips(root)
    blob = build_features(clips)
    blob["class_names"] = class_names_by_target(clips)
    return blob
