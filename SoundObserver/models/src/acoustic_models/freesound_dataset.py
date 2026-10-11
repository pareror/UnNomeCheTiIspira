"""Clean, license-tracked urban safety dataset sourced from Freesound (CC0 / CC-BY).

Why this exists: ``urban_safety`` mixes UrbanSound8K and ESC-50 (both CC BY-NC 3.0)
with an unlicensed scream repo, and splits on a fold column that conflates two
different fold namespaces. This module builds a drop-in replacement that:

- downloads only permissively licensed audio (CC0 / CC-BY) and records the
  license + author for every clip (``attribution.csv`` / ``attribution.md``);
- de-duplicates by audio content (MD5), so re-uploads of the same recording are
  dropped;
- assigns folds by *group* (recording, uploader, or uploader-within-class) so
  train / validation / test never share a recording or a speaker — the leakage
  the old pipeline had between scream fragments;
- writes a checksummed manifest so the exact dataset is versioned.

Taxonomy (safety-first, 8 classes): scream, gunshot, siren, car_horn,
construction, traffic, speech, ambient_quiet.

Requires a free Freesound API key. Put ``FREESOUND_API_KEY=...`` in the repo
``.env`` (gitignored) or export it in the environment.

Example:
    python -m acoustic_models.freesound_dataset --data-root data --max-per-class 120
    python -m acoustic_models.freesound_dataset --verify-splits
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Sequence

import numpy as np
import torch
import yaml

from acoustic_models.data import load_waveform
from acoustic_models.features import LogMel

DATASET_KEY = "freesound_safety"
SUBDIR = "freesound"

CLASS_NAMES = [
    "scream",
    "gunshot",
    "siren",
    "car_horn",
    "construction",
    "traffic",
    "speech",
    "ambient_quiet",
]
CLASS_TO_ID = {name: i for i, name in enumerate(CLASS_NAMES)}

SAFETY_CLASSES = {"scream", "gunshot"}
NORMAL_CLASSES = {"speech", "ambient_quiet", "traffic"}
ANOMALOUS_CLASSES = {"siren", "car_horn", "construction"}

NORMAL_GROUP = "normal"
ANOMALOUS_GROUP = "anomalous"

API_ROOT = "https://freesound.org/apiv2"
SEARCH_FIELDS = "id,name,license,username,url,previews,duration"
LICENSE_URLS = {
    "Creative Commons 0": "https://creativecommons.org/publicdomain/zero/1.0/",
    "Attribution": "https://creativecommons.org/licenses/by/4.0/",
}
# Freesound returns the license *field* as a URL; map fragments back to a name.
_LICENSE_URL_FRAGMENTS = [
    ("publicdomain/zero", "Creative Commons 0"),
    ("licenses/by-nc", "Attribution Noncommercial"),
    ("licenses/by/", "Attribution"),
]


def _normalize_license(raw: str) -> tuple[str, str]:
    """Return ``(friendly_name, license_url)`` from Freesound's license field."""
    raw = (raw or "").strip()
    low = raw.lower()
    if low.startswith("http"):
        for fragment, name in _LICENSE_URL_FRAGMENTS:
            if fragment in low:
                return name, raw
        return raw, raw
    return raw, LICENSE_URLS.get(raw, "")

DEFAULT_CONFIG = Path(__file__).resolve().parents[2] / "configs" / "freesound_safety.yaml"
REPO_ROOT = Path(__file__).resolve().parents[3]


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
    recording_id: str
    source: str
    uploader: str
    license: str
    license_url: str
    source_url: str
    duration: float


# --------------------------------------------------------------------------- #
# config / credentials
# --------------------------------------------------------------------------- #
def _load_dotenv(path: Path) -> None:
    """Populate os.environ from a .env file without overriding existing vars."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and value and key not in os.environ:
            os.environ[key] = value


def get_token(explicit: str | None = None) -> str:
    """Return the Freesound token from the argument, environment, or repo .env."""
    if explicit:
        return explicit
    if not os.environ.get("FREESOUND_API_KEY"):
        _load_dotenv(REPO_ROOT / ".env")
    token = os.environ.get("FREESOUND_API_KEY")
    if not token:
        raise RuntimeError(
            "FREESOUND_API_KEY is not set. Register a free key at "
            "https://freesound.org/apiv2/apply and add 'FREESOUND_API_KEY=...' "
            "to the repository .env file (it is gitignored)."
        )
    return token


def load_config(path: str | os.PathLike | None = None) -> dict:
    cfg_path = Path(path) if path else DEFAULT_CONFIG
    with open(cfg_path, encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh)
    missing = [c for c in CLASS_NAMES if c not in cfg.get("classes", {})]
    if missing:
        raise ValueError(f"config is missing classes: {missing}")
    return cfg


def _license_filter(licenses: Sequence[str]) -> str:
    quoted = " OR ".join(f'"{name}"' for name in licenses)
    return f"license:({quoted})"


# --------------------------------------------------------------------------- #
# Freesound API
# --------------------------------------------------------------------------- #
def _get_json(url: str, params: dict, retries: int = 3) -> dict:
    query = urllib.parse.urlencode(params)
    full = f"{url}?{query}"
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(full, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code in (429, 500, 502, 503):
                time.sleep(1.5 * (attempt + 1))
                continue
            raise
        except Exception as exc:  # noqa: BLE001 - transient network
            last = exc
            time.sleep(1.0 * (attempt + 1))
    raise RuntimeError(f"Freesound request failed: {full} ({last})")


def search_sounds(token: str, query: str, lic_filter: str, page: int, page_size: int, delay: float) -> dict:
    time.sleep(delay)
    return _get_json(
        f"{API_ROOT}/search/text/",
        {
            "query": query,
            "filter": lic_filter,
            "fields": SEARCH_FIELDS,
            "page": page,
            "page_size": page_size,
            "sort": "score",
            "token": token,
        },
    )


def _slug(text: str, limit: int = 40) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return cleaned[:limit] or "clip"


def collect_candidates(token: str, cfg: dict) -> dict[str, list[dict]]:
    """Search each class's queries and return unique candidates above the limits."""
    lic_filter = _license_filter(cfg["licenses"])
    per_class: dict[str, list[dict]] = {name: [] for name in CLASS_NAMES}
    want = int(cfg["max_per_class"]) * 2  # over-fetch, then dedup/filter
    seen_ids: set[int] = set()

    for class_name, spec in cfg["classes"].items():
        for query in spec["queries"]:
            if len(per_class[class_name]) >= want:
                break
            for page in range(1, int(cfg["max_search_pages"]) + 1):
                try:
                    data = search_sounds(
                        token, query, lic_filter, page, int(cfg["page_size"]), float(cfg["request_delay"])
                    )
                except Exception as exc:  # noqa: BLE001
                    print(f"  warning: search '{query}' failed: {exc}")
                    break
                results = data.get("results", [])
                if not results:
                    break
                for item in results:
                    sid = item["id"]
                    dur = float(item.get("duration", 0.0))
                    if sid in seen_ids:
                        continue
                    if not (cfg["min_duration"] <= dur <= cfg["max_duration"]):
                        continue
                    if not item.get("previews"):
                        continue
                    seen_ids.add(sid)
                    per_class[class_name].append(item)
                    if len(per_class[class_name]) >= want:
                        break
                print(f"  [{class_name}] query='{query}' page={page} -> {len(per_class[class_name])} candidates")
                if len(per_class[class_name]) >= want:
                    break
    return per_class


def _download_file(url: str, dest: Path, retries: int = 3) -> None:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=60) as resp:
                dest.write_bytes(resp.read())
            return
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1.0 * (attempt + 1))
    raise RuntimeError(f"download failed: {url} ({last})")


def _md5(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def _pick_preview(previews: dict) -> str | None:
    for key in ("preview-hq-mp3", "preview-lq-mp3", "preview-hq-ogg", "preview-lq-ogg"):
        if previews.get(key):
            return previews[key]
    return None


def download_class(
    class_name: str,
    candidates: list[dict],
    out_dir: Path,
    cfg: dict,
    seen_hashes: set[str],
) -> list[Clip]:
    """Download up to max_per_class unique clips for one class."""
    out_dir.mkdir(parents=True, exist_ok=True)
    target = CLASS_TO_ID[class_name]
    clips: list[Clip] = []
    max_per_class = int(cfg["max_per_class"])

    for item in candidates:
        if len(clips) >= max_per_class:
            break
        preview = _pick_preview(item.get("previews", {}))
        if not preview:
            continue
        ext = os.path.splitext(urllib.parse.urlparse(preview).path)[1] or ".mp3"
        fname = f"{item['id']}_{_slug(item.get('name', 'clip'))}{ext}"
        dest = out_dir / fname
        if not dest.exists():
            try:
                _download_file(preview, dest)
            except Exception as exc:  # noqa: BLE001
                print(f"  warning: {class_name} id={item['id']} download failed: {exc}")
                continue
            time.sleep(float(cfg["request_delay"]))
        digest = _md5(dest)
        if digest in seen_hashes:
            dest.unlink(missing_ok=True)
            continue
        seen_hashes.add(digest)

        lic, lic_url = _normalize_license(item.get("license", "Creative Commons 0"))
        clips.append(
            Clip(
                filename=fname,
                path=str(dest),
                target=target,
                class_name=class_name,
                fold=0,  # assigned later, source-disjoint
                safety_label=float(cfg["classes"][class_name].get("safety", 0.0)),
                recording_id=f"fs:{item['id']}",
                source="freesound",
                uploader=item.get("username", "unknown"),
                license=lic,
                license_url=lic_url,
                source_url=item.get("url", ""),
                duration=float(item.get("duration", 0.0)),
            )
        )
        if len(clips) % 20 == 0:
            print(f"  [{class_name}] downloaded {len(clips)}/{max_per_class}")
    print(f"  [{class_name}] kept {len(clips)} unique clips")
    return clips


# --------------------------------------------------------------------------- #
# source-disjoint fold assignment
# --------------------------------------------------------------------------- #
def _group_key(clip: Clip, group_by: str) -> str:
    if group_by == "recording":
        return clip.recording_id
    if group_by == "uploader":
        return f"up:{clip.uploader}"
    return f"{clip.class_name}:{clip.uploader}"  # uploader_class (default)


def assign_group_folds(
    groups: Sequence[str],
    labels: Sequence[int],
    n_folds: int,
    n_classes: int,
    seed: int = 42,
) -> np.ndarray:
    """Greedy stratified group k-fold.

    A group (recording / speaker) is never split across folds; groups are placed
    to balance the per-class sample counts across folds. Returns fold ids 1..n.
    """
    rng = np.random.default_rng(seed)
    hist: dict[str, np.ndarray] = {}
    for g, lab in zip(groups, labels):
        hist.setdefault(g, np.zeros(n_classes))[lab] += 1.0

    order = list(hist)
    rng.shuffle(order)
    order.sort(key=lambda g: -hist[g].sum())  # largest groups first

    fold_hist = np.zeros((n_folds, n_classes))
    fold_of: dict[str, int] = {}
    for g in order:
        h = hist[g]
        best_f, best_cost = 0, None
        for f in range(n_folds):
            cand = fold_hist[f] + h
            cost = float((cand ** 2).sum()) + 1e-3 * float(cand.sum() ** 2)
            if best_cost is None or cost < best_cost:
                best_cost, best_f = cost, f
        fold_of[g] = best_f + 1
        fold_hist[best_f] += h
    return np.array([fold_of[g] for g in groups], dtype=int)


def _assign_clip_folds(clips: list[Clip], cfg: dict) -> list[Clip]:
    groups = [_group_key(c, cfg.get("group_by", "uploader_class")) for c in clips]
    labels = [c.target for c in clips]
    folds = assign_group_folds(
        groups, labels, int(cfg["n_folds"]), len(CLASS_NAMES), int(cfg.get("seed", 42))
    )
    return [Clip(**{**asdict(c), "fold": int(f)}) for c, f in zip(clips, folds)]


# --------------------------------------------------------------------------- #
# assembly / persistence
# --------------------------------------------------------------------------- #
METADATA_FIELDS = [
    "filename", "path", "target", "class_name", "fold", "safety_label",
    "recording_id", "source", "uploader", "license", "license_url", "source_url", "duration",
]


def _write_metadata(clips: list[Clip], out_dir: Path) -> Path:
    csv_path = out_dir / "metadata.csv"
    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=METADATA_FIELDS)
        writer.writeheader()
        for clip in clips:
            writer.writerow(asdict(clip))
    return csv_path


def _write_attribution(clips: list[Clip], out_dir: Path) -> None:
    rows = sorted(clips, key=lambda c: (c.uploader, c.class_name, c.recording_id))
    with open(out_dir / "attribution.csv", "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["sound_id", "name", "author", "license", "license_url", "source_url", "class_name", "filename"])
        for c in rows:
            writer.writerow([c.recording_id, c.filename, c.uploader, c.license, c.license_url, c.source_url, c.class_name, c.filename])

    lines = ["# Audio attribution", "", "Clips obtained from Freesound (https://freesound.org).", ""]
    by_license: dict[str, list[Clip]] = {}
    for c in rows:
        by_license.setdefault(c.license, []).append(c)
    for lic, items in sorted(by_license.items()):
        lines += [f"## {lic}", ""]
        for c in items:
            lines.append(f"- **{c.filename}** — {c.uploader} ({c.class_name}) — {c.source_url} — {c.license_url or lic}")
        lines.append("")
    (out_dir / "attribution.md").write_text("\n".join(lines), encoding="utf-8")


def _write_manifest(out_dir: Path) -> str:
    """Checksum the sorted (filename, license, uploader) table so the exact dataset is versioned."""
    rows = sorted(csv.DictReader(open(out_dir / "metadata.csv", newline="", encoding="utf-8")), key=lambda r: r["filename"])
    h = hashlib.sha256()
    for r in rows:
        h.update(f"{r['filename']}|{r['license']}|{r['uploader']}|{r['class_name']}|{r['fold']}".encode())
    digest = h.hexdigest()
    (out_dir / "manifest.sha256").write_text(digest + "\n", encoding="utf-8")
    return digest


def assemble_dataset(
    root: str,
    config_path: str | None = None,
    token: str | None = None,
    max_per_class: int | None = None,
) -> list[Clip]:
    """Search, download, dedup and fold the dataset; write metadata + attribution."""
    cfg = load_config(config_path)
    if max_per_class is not None:
        cfg["max_per_class"] = max_per_class
    tok = get_token(token)

    out_dir = Path(root) / SUBDIR
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"searching Freesound ({_license_filter(cfg['licenses'])}) ...")
    candidates = collect_candidates(tok, cfg)

    clips: list[Clip] = []
    seen_hashes: set[str] = set()
    for class_name in CLASS_NAMES:
        cands = candidates.get(class_name, [])
        print(f"downloading class '{class_name}' ({len(cands)} candidates) ...")
        clips.extend(download_class(class_name, cands, out_dir / class_name, cfg, seen_hashes))

    if not clips:
        raise RuntimeError("no clips downloaded - check the token, license filter and queries")

    clips = _assign_clip_folds(clips, cfg)
    _write_metadata(clips, out_dir)
    _write_attribution(clips, out_dir)
    digest = _write_manifest(out_dir)
    print(f"assembled {len(clips)} clips across {len(CLASS_NAMES)} classes -> {out_dir}")
    print(f"manifest sha256: {digest}")
    return clips


def load_clips(root: str) -> list[Clip]:
    out_dir = Path(root) / SUBDIR
    csv_path = out_dir / "metadata.csv"
    if not csv_path.exists():
        print(f"metadata not found at {csv_path}, assembling dataset ...")
        return assemble_dataset(root)
    clips: list[Clip] = []
    with open(csv_path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            clips.append(
                Clip(
                    filename=row["filename"],
                    path=row["path"],
                    target=int(row["target"]),
                    class_name=row["class_name"],
                    fold=int(row["fold"]),
                    safety_label=float(row["safety_label"]),
                    recording_id=row.get("recording_id", ""),
                    source=row.get("source", "freesound"),
                    uploader=row.get("uploader", ""),
                    license=row.get("license", ""),
                    license_url=row.get("license_url", ""),
                    source_url=row.get("source_url", ""),
                    duration=float(row.get("duration", 0.0) or 0.0),
                )
            )
    return clips


# --------------------------------------------------------------------------- #
# features
# --------------------------------------------------------------------------- #
def build_features(
    clips: list[Clip],
    win_seconds: float = 1.0,
    hop_seconds: float = 1.0,
    sample_rate: int = 16000,
    logmel: LogMel | None = None,
    group_by: str = "recording",
    verbose: bool = True,
) -> dict:
    logmel = logmel or LogMel(sample_rate=sample_rate)
    win = int(win_seconds * sample_rate)
    default_hop = int(hop_seconds * sample_rate)

    feats, labels, safety_labels, folds, clip_ids, class_names, groups, uploaders = (
        [], [], [], [], [], [], [], [],
    )
    skipped = 0
    for clip_id, clip in enumerate(clips):
        try:
            wave = load_waveform(clip.path, sample_rate)
        except Exception as exc:  # noqa: BLE001
            skipped += 1
            if verbose and skipped <= 5:
                print(f"  skipping {clip.filename}: {exc}")
            continue
        hop = default_hop
        if clip.class_name == "scream":
            hop = max(1, int(0.5 * sample_rate))
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
            safety_labels.append(clip.safety_label)
            folds.append(clip.fold)
            clip_ids.append(clip_id)
            class_names.append(clip.class_name)
            groups.append(_group_key(clip, group_by))
            uploaders.append(clip.uploader)
        if verbose and (clip_id + 1) % 200 == 0:
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
        "group_name": np.asarray(groups),
        "uploader": np.asarray(uploaders),
        "group": np.asarray([group_of(c) for c in class_names]),
    }


def download(root: str) -> str:
    assemble_dataset(root)
    return root


def compute_split(
    clip_id: np.ndarray,
    fold: np.ndarray,
    groups: np.ndarray,
    test_fold: int = 10,
    val_frac: float = 0.1,
    seed: int = 42,
) -> np.ndarray:
    """Group-disjoint train/val/test labels (one per window).

    ``fold == test_fold`` is the test set; validation is carved out of the rest
    by whole groups, so a recording/speaker never straddles train and val either.
    """
    split = np.full(len(clip_id), "train", dtype=object)
    test = fold == test_fold
    split[test] = "test"

    rest_groups = np.unique(groups[~test])
    rng = np.random.default_rng(seed)
    perm = rng.permutation(len(rest_groups))
    n_val = max(1, int(len(rest_groups) * val_frac))
    val_groups = set(rest_groups[perm[:n_val]].tolist())
    is_val = np.array([g in val_groups for g in groups])
    split[is_val & ~test] = "val"
    return split


def _blob_from_clips(clips: list[Clip], cfg: dict, verbose: bool = True) -> dict:
    logmel = LogMel(sample_rate=16000, target_frames=49)
    blob = build_features(clips, logmel=logmel, group_by=cfg.get("group_by", "recording"), verbose=verbose)
    blob["class_names"] = CLASS_NAMES
    blob["normal_group"] = NORMAL_GROUP
    blob["anomalous_group"] = ANOMALOUS_GROUP
    blob["win_seconds"] = 1.0
    blob["target_frames"] = 49
    blob["split"] = compute_split(
        np.asarray(blob["clip_id"]), np.asarray(blob["fold"]), np.asarray(blob["group_name"])
    )
    return blob


def build_blob(root: str) -> dict:
    return _blob_from_clips(load_clips(root), load_config())


def refold(root: str, config_path: str | None = None, out_cache: str | None = None) -> list[Clip]:
    """Re-assign folds from the frozen ``metadata.csv`` (no network) and rebuild the blob.

    Useful to switch ``group_by`` or re-partition without re-downloading.
    """
    cfg = load_config(config_path)
    out_dir = Path(root) / SUBDIR
    clips = _assign_clip_folds(load_clips(root), cfg)
    _write_metadata(clips, out_dir)
    _write_attribution(clips, out_dir)
    print(f"refolded {len(clips)} clips (group_by={cfg.get('group_by')}) -> {out_dir}")
    print(f"manifest sha256: {_write_manifest(out_dir)}")
    if out_cache:
        blob = _blob_from_clips(clips, cfg, verbose=False)
        os.makedirs(os.path.dirname(out_cache) or ".", exist_ok=True)
        torch.save(blob, out_cache)
        print(f"saved feature blob ({blob['X'].shape[0]} windows) -> {out_cache}")
    return clips


def verify_disjoint_splits(
    blob_or_path: dict | str = "data/freesound_features.pt",
    test_fold: int = 10,
    val_frac: float = 0.1,
    seed: int = 42,
) -> dict:
    """Verify train/val/test do not share clips *or their source group*."""
    blob = torch.load(blob_or_path, weights_only=False) if isinstance(blob_or_path, str) else blob_or_path

    clip_id = np.asarray(blob["clip_id"])
    fold = np.asarray(blob["fold"])
    groups = np.asarray(blob.get("group_name", np.array([""] * len(clip_id), dtype=object)))

    if "split" in blob:
        split = np.asarray(blob["split"])
        tr = np.where(split == "train")[0]
        val = np.where(split == "val")[0]
        te = np.where(split == "test")[0]
    else:
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

    tr_set, va_set, te_set = set(clip_id[tr].tolist()), set(clip_id[val].tolist()), set(clip_id[te].tolist())
    tr_g, va_g, te_g = set(groups[tr].tolist()), set(groups[val].tolist()), set(groups[te].tolist())
    uploaders = np.asarray(blob.get("uploader", np.array([""] * len(clip_id), dtype=object)))
    tr_u, va_u, te_u = set(uploaders[tr].tolist()), set(uploaders[val].tolist()), set(uploaders[te].tolist())

    return {
        "is_disjoint": not (tr_set & va_set or tr_set & te_set or va_set & te_set)
        and not (tr_g & va_g or tr_g & te_g or va_g & te_g),
        "train_clips": len(tr_set), "val_clips": len(va_set), "test_clips": len(te_set),
        "train_windows": int(len(tr)), "val_windows": int(len(val)), "test_windows": int(len(te)),
        "overlap_train_val": len(tr_set & va_set),
        "overlap_train_test": len(tr_set & te_set),
        "overlap_val_test": len(va_set & te_set),
        "group_overlap_train_val": len(tr_g & va_g),
        "group_overlap_train_test": len(tr_g & te_g),
        "group_overlap_val_test": len(va_g & te_g),
        "uploader_overlap_train_test": len(tr_u & te_u),
        "uploader_overlap_val_test": len(va_u & te_u),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", default="data")
    parser.add_argument("--config", default=None, help="config YAML path")
    parser.add_argument("--max-per-class", type=int, default=None)
    parser.add_argument("--out-cache", default="data/freesound_features.pt")
    parser.add_argument("--verify-splits", action="store_true")
    parser.add_argument("--refold", action="store_true", help="re-partition from frozen metadata (no download)")
    args = parser.parse_args()

    if args.verify_splits:
        res = verify_disjoint_splits(args.out_cache)
        print(json.dumps(res, indent=2))
        print(">>> SUCCESS: source-disjoint." if res["is_disjoint"] else ">>> WARNING: leakage detected!")
        return

    if args.refold:
        refold(args.data_root, args.config, out_cache=args.out_cache)
        return

    clips = assemble_dataset(args.data_root, args.config, max_per_class=args.max_per_class)
    blob = _blob_from_clips(clips, load_config(args.config))
    os.makedirs(os.path.dirname(args.out_cache), exist_ok=True)
    torch.save(blob, args.out_cache)
    print(f"saved feature blob ({blob['X'].shape[0]} windows, shape {tuple(blob['X'].shape)}) -> {args.out_cache}")


if __name__ == "__main__":
    main()
