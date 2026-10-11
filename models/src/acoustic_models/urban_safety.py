"""Urban Safety and Danger Audio Dataset (9 classes).

A curated balanced audio dataset combining:
- Scream detection (distress / cries for help) for critical safety alerts
- Gunshots / explosions
- Siren / emergency alerts
- Traffic & engine noise
- Speech & human conversational sounds
- Car horns
- Construction / machinery noise
- Impact & crashes (glass breaking, collisions)
- Ambient quiet & benign background sounds

Audio sources:
- Screams: auto-downloaded from open Freesound scream recordings (kd-abhidev/Human-scream-detection)
  and any user-provided WAVs in ``models/data/custom/scream/``.
- Gunshots, sirens, horns, traffic, construction, ambient: UrbanSound8K (CC BY-NC 3.0).
- Speech, crashes, domestic ambient: ESC-50 (CC BY-NC 3.0).

Designed for 16 kHz mono 1-second analysis on TinyML microcontrollers (ESP32-S3).
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import shutil
import urllib.request
from dataclasses import dataclass
from typing import Sequence

import numpy as np
import torch

from acoustic_models.data import load_waveform
from acoustic_models.features import LogMel

CLASS_NAMES = [
    "scream",
    "gunshot",
    "siren",
    "traffic",
    "speech",
    "car_horn",
    "construction",
    "impact_crash",
    "ambient_quiet",
]

CLASS_TO_ID = {name: i for i, name in enumerate(CLASS_NAMES)}

NORMAL_CLASSES = {"traffic", "speech", "ambient_quiet"}
ANOMALOUS_CLASSES = {"scream", "gunshot", "siren", "car_horn", "construction", "impact_crash"}
SAFETY_CLASSES = {"scream", "gunshot"}

NORMAL_GROUP = "normal"
ANOMALOUS_GROUP = "anomalous"


def group_of(class_name: str) -> str:
    if class_name in NORMAL_CLASSES:
        return NORMAL_GROUP
    if class_name in ANOMALOUS_CLASSES:
        return ANOMALOUS_GROUP
    return "other"


def safety_of(class_name: str) -> float:
    return 1.0 if class_name in SAFETY_CLASSES else 0.0


@dataclass(frozen=True)
class Clip:
    filename: str
    path: str
    target: int
    class_name: str
    fold: int
    safety_label: float


# Fallback list of positive scream WAV files from Freesound/GitHub repository
SCREAM_FILENAMES = [
    "169810__missozzy__female-scream-01_0.wav",
    "169810__missozzy__female-scream-01_1.wav",
    "319258__ramston__woman-screaming-of-fear.wav",
    "343916__reitanna__screaming-and-why.wav",
    "359154__horroraudio__muffled-female-cry.wav",
    "Scream+25.wav",
    "Scream+26.wav",
    "abuse_female_scream.wav",
    "abuse_female_screaming-and-why.wav",
    "damm_0.wav",
    "damm_1.wav",
    "damm_2.wav",
    "damm_3.wav",
    "damm_4.wav",
    "damm_5.wav",
    "damm_6.wav",
    "damm_7.wav",
    "femaleScream-002.wav",
    "femaleScream-004.wav",
    "femaleScream-006.wav",
    "femaleScream-007.wav",
    "femaleScream-022.wav",
    "femaleScream-023.wav",
    "femaleScream-027.wav",
    "femaleScream-028.wav",
    "femaleScream-029.wav",
    "femaleScream-032.wav",
    "femaleScream-034.wav",
    "femaleScream-037.wav",
    "femaleScream-051.wav",
    "femaleScream-055.wav",
    "femaleScream-061.wav",
    "femaleScream-062.wav",
    "femaleScream-064.wav",
    "femaleScream-065.wav",
    "femaleScream-069.wav",
    "long_test_abuse_many_blanks.wav",
    "maleScream-002.wav",
    "maleScream-004.wav",
    "maleScream-007.wav",
    "maleScream-016.wav",
    "maleScream-021.wav",
    "maleScream-022.wav",
    "maleScream-024.wav",
    "maleScream-025.wav",
    "maleScream-026.wav",
    "maleScream-027.wav",
    "maleScream-028.wav",
    "maleScream-029.wav",
    "maleScream-032.wav",
    "maleScream-036.wav",
    "maleScream-037.wav",
    "maleScream-038.wav",
    "maleScream-039.wav",
    "maleScream-046.wav",
    "maleScream-049.wav",
    "maleScream-056.wav",
    "maleScream-064.wav",
    "maleScream-065.wav",
    "maleScream-067.wav",
    "maleScream-069.wav",
    "maleScream-070.wav",
    "maleScream-072.wav",
    "maleScream-082.wav",
    "scream_0.wav",
    "scream_1.wav",
    "scream_2.wav",
    "scream_3.wav",
    "scream_4.wav",
    "scream_p2_0.wav",
    "scream_p2_1.wav",
    "scream_p2_2.wav",
]

RAW_SCREAM_BASE_URL = (
    "https://raw.githubusercontent.com/kd-abhidev/Human-scream-detection/master/positive"
)


def download_screams(out_dir: str) -> list[str]:
    """Download positive scream WAV samples from GitHub/Freesound repository."""
    os.makedirs(out_dir, exist_ok=True)
    downloaded = []
    print(f"checking/downloading screams to {out_dir} ...")
    for fn in SCREAM_FILENAMES:
        dest = os.path.join(out_dir, fn)
        if not os.path.exists(dest) or os.path.getsize(dest) == 0:
            url = f"{RAW_SCREAM_BASE_URL}/{fn}"
            try:
                urllib.request.urlretrieve(url, dest)
            except Exception as exc:
                print(f"  warning: failed to download {fn}: {exc}")
                continue
        downloaded.append(dest)
    print(f"ready: {len(downloaded)} scream samples available in {out_dir}")
    return downloaded


def _find_us8k_csv(root: str) -> str | None:
    direct = os.path.join(root, "urbansound8k", "UrbanSound8K", "metadata", "UrbanSound8K.csv")
    if os.path.exists(direct):
        return direct
    direct2 = os.path.join(root, "UrbanSound8K", "metadata", "UrbanSound8K.csv")
    if os.path.exists(direct2):
        return direct2
    for dirpath, _dirs, files in os.walk(root):
        if "UrbanSound8K.csv" in files:
            return os.path.join(dirpath, "UrbanSound8K.csv")
    return None


def _find_esc50_csv(root: str) -> str | None:
    direct = os.path.join(root, "esc50", "ESC-50-master", "meta", "esc50.csv")
    if os.path.exists(direct):
        return direct
    direct2 = os.path.join(root, "ESC-50-master", "meta", "esc50.csv")
    if os.path.exists(direct2):
        return direct2
    for dirpath, _dirs, files in os.walk(root):
        if "esc50.csv" in files:
            return os.path.join(dirpath, "esc50.csv")
    return None


def assemble_dataset(
    data_root: str,
    out_dir: str | None = None,
    max_per_class: int = 150,
    seed: int = 42,
) -> list[Clip]:
    """Assemble a balanced 9-class dataset from US8K, ESC-50, and screams.

    Writes metadata to ``{out_dir}/metadata.csv``.
    """
    if out_dir is None:
        out_dir = os.path.join(data_root, "urban_safety")
    os.makedirs(out_dir, exist_ok=True)
    csv_out = os.path.join(out_dir, "metadata.csv")

    rng = np.random.default_rng(seed)

    # 1. Download / locate screams
    scream_raw_dir = os.path.join(data_root, "raw_screams")
    download_screams(scream_raw_dir)

    # Also check optional custom user folder
    custom_scream_dir = os.path.join(data_root, "custom", "scream")
    scream_paths = [
        os.path.join(scream_raw_dir, f)
        for f in os.listdir(scream_raw_dir)
        if f.lower().endswith(".wav")
    ]
    if os.path.exists(custom_scream_dir):
        scream_paths.extend([
            os.path.join(custom_scream_dir, f)
            for f in os.listdir(custom_scream_dir)
            if f.lower().endswith(".wav")
        ])

    # 2. Locate US8K clips
    us8k_csv = _find_us8k_csv(data_root)
    us8k_by_class: dict[str, list[tuple[str, int]]] = {}
    if us8k_csv:
        base = os.path.dirname(os.path.dirname(us8k_csv))
        with open(us8k_csv, newline="") as fh:
            for row in csv.DictReader(fh):
                cname = row["class"]
                fold = int(row["fold"])
                p = os.path.join(base, "audio", f"fold{fold}", row["slice_file_name"])
                if os.path.exists(p):
                    us8k_by_class.setdefault(cname, []).append((p, fold))

    # 3. Locate ESC-50 clips
    esc50_csv = _find_esc50_csv(data_root)
    esc50_by_cat: dict[str, list[tuple[str, int]]] = {}
    if esc50_csv:
        base = os.path.dirname(os.path.dirname(esc50_csv))
        with open(esc50_csv, newline="") as fh:
            for row in csv.DictReader(fh):
                cat = row["category"]
                fold = int(row["fold"])
                p = os.path.join(base, "audio", row["filename"])
                if os.path.exists(p):
                    esc50_by_cat.setdefault(cat, []).append((p, fold))

    clips: list[Clip] = []

    # Map candidate sources into our 9 classes
    # For each class, pick up to max_per_class items balanced across folds
    def sample_balanced(items: list[tuple[str, int]], limit: int) -> list[tuple[str, int]]:
        if len(items) <= limit:
            return items
        # Shuffle deterministically
        indices = rng.permutation(len(items))[:limit]
        return [items[i] for i in indices]

    # Class 0: scream
    scream_items = []
    for i, p in enumerate(scream_paths):
        # Distribute scream folds across 1..10
        f = (i % 10) + 1
        scream_items.append((p, f))
    for p, f in scream_items:
        clips.append(
            Clip(
                filename=os.path.basename(p),
                path=p,
                target=CLASS_TO_ID["scream"],
                class_name="scream",
                fold=f,
                safety_label=1.0,
            )
        )

    # Class 1: gunshot (US8K gun_shot)
    gun_items = us8k_by_class.get("gun_shot", [])
    for p, f in sample_balanced(gun_items, max_per_class):
        clips.append(
            Clip(
                filename=os.path.basename(p),
                path=p,
                target=CLASS_TO_ID["gunshot"],
                class_name="gunshot",
                fold=f,
                safety_label=1.0,
            )
        )

    # Class 2: siren (US8K siren)
    siren_items = us8k_by_class.get("siren", [])
    for p, f in sample_balanced(siren_items, max_per_class):
        clips.append(
            Clip(
                filename=os.path.basename(p),
                path=p,
                target=CLASS_TO_ID["siren"],
                class_name="siren",
                fold=f,
                safety_label=0.0,
            )
        )

    # Class 3: traffic (US8K engine_idling + ESC50 engine)
    traffic_items = us8k_by_class.get("engine_idling", []) + esc50_by_cat.get("engine", [])
    for p, f in sample_balanced(traffic_items, max_per_class):
        clips.append(
            Clip(
                filename=os.path.basename(p),
                path=p,
                target=CLASS_TO_ID["traffic"],
                class_name="traffic",
                fold=f,
                safety_label=0.0,
            )
        )

    # Class 4: speech (US8K children_playing + ESC50 vocal sounds)
    speech_items = (
        us8k_by_class.get("children_playing", [])
        + esc50_by_cat.get("laughing", [])
        + esc50_by_cat.get("crying_baby", [])
        + esc50_by_cat.get("coughing", [])
    )
    for p, f in sample_balanced(speech_items, max_per_class):
        clips.append(
            Clip(
                filename=os.path.basename(p),
                path=p,
                target=CLASS_TO_ID["speech"],
                class_name="speech",
                fold=f,
                safety_label=0.0,
            )
        )

    # Class 5: car_horn (US8K car_horn + ESC50 car_horn)
    horn_items = us8k_by_class.get("car_horn", []) + esc50_by_cat.get("car_horn", [])
    for p, f in sample_balanced(horn_items, max_per_class):
        clips.append(
            Clip(
                filename=os.path.basename(p),
                path=p,
                target=CLASS_TO_ID["car_horn"],
                class_name="car_horn",
                fold=f,
                safety_label=0.0,
            )
        )

    # Class 6: construction (US8K drilling + jackhammer)
    const_items = us8k_by_class.get("drilling", []) + us8k_by_class.get("jackhammer", [])
    for p, f in sample_balanced(const_items, max_per_class):
        clips.append(
            Clip(
                filename=os.path.basename(p),
                path=p,
                target=CLASS_TO_ID["construction"],
                class_name="construction",
                fold=f,
                safety_label=0.0,
            )
        )

    # Class 7: impact_crash (ESC50 glass_breaking + door_wood_knock)
    crash_items = esc50_by_cat.get("glass_breaking", []) + esc50_by_cat.get("door_wood_knock", [])
    for p, f in sample_balanced(crash_items, max_per_class):
        clips.append(
            Clip(
                filename=os.path.basename(p),
                path=p,
                target=CLASS_TO_ID["impact_crash"],
                class_name="impact_crash",
                fold=f,
                safety_label=0.0,
            )
        )

    # Class 8: ambient_quiet (US8K air_conditioner, street_music + ESC50 rain, wind)
    amb_items = (
        us8k_by_class.get("air_conditioner", [])
        + us8k_by_class.get("street_music", [])
        + esc50_by_cat.get("rain", [])
        + esc50_by_cat.get("wind", [])
    )
    for p, f in sample_balanced(amb_items, max_per_class):
        clips.append(
            Clip(
                filename=os.path.basename(p),
                path=p,
                target=CLASS_TO_ID["ambient_quiet"],
                class_name="ambient_quiet",
                fold=f,
                safety_label=0.0,
            )
        )

    # Write metadata.csv
    with open(csv_out, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["filename", "path", "target", "class_name", "fold", "safety_label"])
        for c in clips:
            writer.writerow([c.filename, c.path, c.target, c.class_name, c.fold, c.safety_label])

    print(f"assembled {len(clips)} clips across {len(CLASS_NAMES)} classes -> {csv_out}")
    return clips


def load_clips(root: str) -> list[Clip]:
    """Load assembled clips from ``{root}/urban_safety/metadata.csv``."""
    csv_path = os.path.join(root, "urban_safety", "metadata.csv")
    if not os.path.exists(csv_path):
        csv_path = os.path.join(root, "metadata.csv")
    if not os.path.exists(csv_path):
        print(f"metadata not found at {csv_path}, assembling dataset...")
        return assemble_dataset(root)

    clips: list[Clip] = []
    with open(csv_path, newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            clips.append(
                Clip(
                    filename=row["filename"],
                    path=row["path"],
                    target=int(row["target"]),
                    class_name=row["class_name"],
                    fold=int(row["fold"]),
                    safety_label=float(row["safety_label"]),
                )
            )
    return clips


def build_features(
    clips: list[Clip],
    win_seconds: float = 1.0,
    hop_seconds: float = 1.0,
    scream_hop_seconds: float = 0.5,
    sample_rate: int = 16000,
    logmel: LogMel | None = None,
    verbose: bool = True,
) -> dict:
    """Split clips into 1 s windows and compute log-mel features.

    Uses a tighter hop (0.5 s) for the scream class to provide denser coverage.
    """
    logmel = logmel or LogMel(sample_rate=sample_rate)
    win = int(win_seconds * sample_rate)
    default_hop = int(hop_seconds * sample_rate)
    scream_hop = int(scream_hop_seconds * sample_rate)

    feats, labels, safety_labels, folds, clip_ids, class_names = [], [], [], [], [], []
    skipped = 0

    for clip_id, clip in enumerate(clips):
        try:
            wave = load_waveform(clip.path, sample_rate)
        except Exception as exc:
            skipped += 1
            if verbose and skipped <= 5:
                print(f"  skipping {clip.filename}: {exc}")
            continue

        hop = scream_hop if clip.class_name == "scream" else default_hop
        if wave.shape[0] < win:
            wave = torch.nn.functional.pad(wave, (0, win - wave.shape[0]))
            starts = [0]
        else:
            starts = list(range(0, wave.shape[0] - win + 1, hop))

        for start in starts:
            window = wave[start : start + win]
            with torch.no_grad():
                feat = logmel(window)[0]  # (1, n_mels, frames)
            feats.append(feat)
            labels.append(clip.target)
            safety_labels.append(clip.safety_label)
            folds.append(clip.fold)
            clip_ids.append(clip_id)
            class_names.append(clip.class_name)

        if verbose and (clip_id + 1) % 500 == 0:
            print(f"  featurized {clip_id + 1}/{len(clips)} clips")

    if not feats:
        raise RuntimeError("no windows produced from dataset clips")
    if skipped and verbose:
        print(f"  skipped {skipped} unreadable clips")

    return {
        "X": torch.stack(feats),
        "y": np.asarray(labels),
        "safety": np.asarray(safety_labels, dtype=np.float32),
        "fold": np.asarray(folds),
        "clip_id": np.asarray(clip_ids),
        "class_name": np.asarray(class_names),
        "group": np.asarray([group_of(c) for c in class_names]),
    }


def download(root: str) -> str:
    """Download dependencies and assemble dataset into root."""
    assemble_dataset(root)
    return root


def build_blob(root: str) -> dict:
    """Load + featurize, returning the blob expected by the experiments runner."""
    clips = load_clips(root)
    blob = build_features(clips)
    blob["class_names"] = CLASS_NAMES
    blob["normal_group"] = NORMAL_GROUP
    blob["anomalous_group"] = ANOMALOUS_GROUP
    return blob


def verify_disjoint_splits(
    blob_or_path: dict | str = "data/urban_safety_features.pt",
    test_fold: int = 10,
    val_frac: float = 0.1,
    seed: int = 42,
) -> dict:
    """Verify that train, val, and test splits are strictly disjoint at clip level."""
    if isinstance(blob_or_path, str):
        blob = torch.load(blob_or_path, weights_only=False)
    else:
        blob = blob_or_path

    clip_id = blob["clip_id"]
    fold = blob["fold"]

    rng = np.random.default_rng(seed)
    tr_all = np.where(fold != test_fold)[0]
    te = np.where(fold == test_fold)[0]

    train_clips = np.unique(clip_id[tr_all])
    perm = rng.permutation(len(train_clips))
    n_val = max(1, int(len(train_clips) * val_frac))
    val_clips = set(train_clips[perm[:n_val]].tolist())
    is_val = np.array([c in val_clips for c in clip_id[tr_all]])
    val = tr_all[is_val]
    tr = tr_all[~is_val]

    train_set = set(clip_id[tr].tolist())
    val_set = set(clip_id[val].tolist())
    test_set = set(clip_id[te].tolist())

    leak_train_val = train_set & val_set
    leak_train_test = train_set & test_set
    leak_val_test = val_set & test_set

    is_disjoint = (
        len(leak_train_val) == 0
        and len(leak_train_test) == 0
        and len(leak_val_test) == 0
    )

    stats = {
        "is_disjoint": is_disjoint,
        "train_clips": len(train_set),
        "val_clips": len(val_set),
        "test_clips": len(test_set),
        "train_windows": int(len(tr)),
        "val_windows": int(len(val)),
        "test_windows": int(len(te)),
        "overlap_train_val": len(leak_train_val),
        "overlap_train_test": len(leak_train_test),
        "overlap_val_test": len(leak_val_test),
    }
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", default="data", help="path to data root directory")
    parser.add_argument("--max-per-class", type=int, default=150, help="max clips per class")
    parser.add_argument("--out-cache", default="data/urban_safety_features.pt", help="cache path")
    parser.add_argument("--win-seconds", type=float, default=1.0, help="window length in seconds (1.0 or 5.0)")
    parser.add_argument("--hop-seconds", type=float, default=None, help="hop length in seconds")
    parser.add_argument("--scream-hop-seconds", type=float, default=None, help="scream hop length in seconds")
    parser.add_argument("--verify-splits", action="store_true", help="verify disjointness of train/val/test splits")
    args = parser.parse_args()

    if args.verify_splits:
        cache_path = args.out_cache
        if not os.path.exists(cache_path) and os.path.exists(os.path.join(args.data_root, "urban_safety_features.pt")):
            cache_path = os.path.join(args.data_root, "urban_safety_features.pt")
        print(f"Verifying split disjointness on {cache_path} ...")
        res = verify_disjoint_splits(cache_path)
        print(json.dumps(res, indent=2))
        if res["is_disjoint"]:
            print(">>> SUCCESS: Train, Validation and Test splits are 100% DISJOINT (0 clip overlap).")
        else:
            print(">>> WARNING: Data leakage detected!")
        return

    print(f"=== Urban Safety Audio Dataset Pipeline ({args.win_seconds}s windows) ===")
    print(f"Classes ({len(CLASS_NAMES)}): {', '.join(CLASS_NAMES)}")
    clips = assemble_dataset(args.data_root, max_per_class=args.max_per_class)
    print(f"Featurizing {len(clips)} clips with win_seconds={args.win_seconds}s ...")

    target_frames = 49 if args.win_seconds <= 1.0 else 249
    hop_sec = args.hop_seconds if args.hop_seconds is not None else (2.5 if args.win_seconds >= 5.0 else args.win_seconds)
    scream_hop_sec = (
        args.scream_hop_seconds
        if args.scream_hop_seconds is not None
        else (1.5 if args.win_seconds >= 5.0 else 0.5)
    )

    logmel = LogMel(sample_rate=16000, target_frames=target_frames)
    blob = build_features(
        clips,
        win_seconds=args.win_seconds,
        hop_seconds=hop_sec,
        scream_hop_seconds=scream_hop_sec,
        logmel=logmel,
    )
    blob["class_names"] = CLASS_NAMES
    blob["normal_group"] = NORMAL_GROUP
    blob["anomalous_group"] = ANOMALOUS_GROUP
    blob["win_seconds"] = args.win_seconds
    blob["target_frames"] = target_frames

    os.makedirs(os.path.dirname(args.out_cache), exist_ok=True)
    torch.save(blob, args.out_cache)
    print(f"Saved feature blob ({blob['X'].shape[0]} windows, shape {tuple(blob['X'].shape)}) -> {args.out_cache}")


if __name__ == "__main__":
    main()
