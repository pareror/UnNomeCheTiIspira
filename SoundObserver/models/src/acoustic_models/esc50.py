"""ESC-50 dataset loading, label taxonomy and feature building.

ESC-50 (Piczak, 2015) is 2000 five-second environmental clips, 50 semantic
classes, pre-split into 5 folds. License: CC BY-NC 3.0 (non-commercial).

The CSV ``category`` column holds the 50 class *names* (e.g. ``dog``, ``rain``).
We group them into the five major ESC-50 categories and, for the anomaly task,
use:

- **normal**    -- natural soundscapes & water sounds
- **anomalous** -- exterior/urban noises
"""

from __future__ import annotations

import csv
import os
import urllib.request
import zipfile
from dataclasses import dataclass

import numpy as np
import torch

from acoustic_models.data import load_waveform
from acoustic_models.features import LogMel

ESC50_URL = "https://github.com/karolpiczak/ESC-50/archive/master.zip"

# The five major ESC-50 categories (from the dataset README).
CLASS_GROUPS: dict[str, set[str]] = {
    "animals": {
        "dog", "rooster", "pig", "cow", "frog", "cat", "hen", "insects", "sheep", "crow",
    },
    "natural": {
        "rain", "sea_waves", "crackling_fire", "crickets", "chirping_birds",
        "water_drops", "wind", "pouring_water", "toilet_flush", "thunderstorm",
    },
    "human": {
        "crying_baby", "sneezing", "clapping", "breathing", "coughing",
        "footsteps", "laughing", "brushing_teeth", "snoring", "drinking_sipping",
    },
    "domestic": {
        "door_knock", "mouse_click", "keyboard_typing", "door_wood_creaks",
        "can_opening", "washing_machine", "vacuum_cleaner", "clock_alarm",
        "clock_tick", "glass_breaking",
    },
    "urban": {
        "helicopter", "chainsaw", "siren", "car_horn", "engine",
        "train", "church_bells", "airplane", "fireworks", "hand_saw",
    },
}

# Anomaly task: learn "normal" = natural, detect "anomalous" = urban.
NORMAL_GROUP = "natural"
ANOMALOUS_GROUP = "urban"

_NAME_TO_GROUP = {name: group for group, names in CLASS_GROUPS.items() for name in names}


def group_of(class_name: str) -> str:
    return _NAME_TO_GROUP.get(class_name, "unknown")


@dataclass(frozen=True)
class Clip:
    filename: str
    path: str
    target: int
    class_name: str
    fold: int


def download(root: str, url: str = ESC50_URL) -> str:
    os.makedirs(root, exist_ok=True)
    zip_path = os.path.join(root, "esc50.zip")
    if not os.path.exists(zip_path):
        print(f"downloading ESC-50 -> {zip_path}")
        urllib.request.urlretrieve(url, zip_path)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(root)
    return root


def _find_csv(root: str) -> str:
    direct = os.path.join(root, "meta", "esc50.csv")
    if os.path.exists(direct):
        return direct
    for dirpath, _dirs, files in os.walk(root):
        if "esc50.csv" in files:
            return os.path.join(dirpath, "esc50.csv")
    raise FileNotFoundError(f"esc50.csv not found under {root}")


def load_clips(root: str) -> list[Clip]:
    csv_path = _find_csv(root)
    base = os.path.dirname(os.path.dirname(csv_path))  # .../ESC-50-master
    clips: list[Clip] = []
    with open(csv_path, newline="") as fh:
        for row in csv.DictReader(fh):
            clips.append(
                Clip(
                    filename=row["filename"],
                    path=os.path.join(base, "audio", row["filename"]),
                    target=int(row["target"]),
                    class_name=row["category"],
                    fold=int(row["fold"]),
                )
            )
    if not clips:
        raise RuntimeError("no ESC-50 clips found")
    return clips


def class_names_by_target(clips: list[Clip]) -> list[str]:
    """Ordered class name for each target index (0..49)."""
    names = [""] * (max(c.target for c in clips) + 1)
    for clip in clips:
        names[clip.target] = clip.class_name
    return names


def _load_waveform(path: str, target_sr: int = 16000) -> torch.Tensor:
    return load_waveform(path, target_sr)


def build_features(
    clips: list[Clip],
    win_seconds: float = 1.0,
    hop_seconds: float = 1.0,
    sample_rate: int = 16000,
    logmel: LogMel | None = None,
    verbose: bool = True,
) -> dict:
    """Split each clip into windows and compute log-mel features.

    Returns ``X`` (N,1,n_mels,frames), ``y`` (N,), ``fold`` (N,), ``clip_id``
    (N,), ``class_name`` (N,) and ``group`` (N,).
    """
    logmel = logmel or LogMel(sample_rate=sample_rate)
    win = int(win_seconds * sample_rate)
    hop = int(hop_seconds * sample_rate)

    feats, labels, folds, clip_ids, class_names = [], [], [], [], []
    for clip_id, clip in enumerate(clips):
        wave = _load_waveform(clip.path, sample_rate)
        for start in range(0, max(0, wave.shape[0] - win + 1), hop):
            window = wave[start : start + win]
            with torch.no_grad():
                feat = logmel(window)[0]  # (1, n_mels, frames)
            feats.append(feat)
            labels.append(clip.target)
            folds.append(clip.fold)
            clip_ids.append(clip_id)
            class_names.append(clip.class_name)
        if verbose and (clip_id + 1) % 500 == 0:
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
