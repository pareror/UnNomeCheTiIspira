"""Evaluate the deployed model on labeled clips and curate a pitch demo set.

For each urban-safety class it runs every candidate clip (1 s windows, mean
softmax) through the model in ``--model-dir``, then copies the best *correctly
classified* clip per class into ``--out`` as a 16 kHz mono WAV, so it can be
replayed directly by the app:

    EDGE_SOURCE=wav EDGE_WAV=test_sounds/scream.wav python python/main.py

Held-out clips (``--test-fold``) are preferred when available, so the demo does
not rely on clips the model memorised. A ``manifest.json`` records the source
file, confidence and whether the clip was held out.

Example:

    python arduino/uno_q/tools/build_test_sounds.py \
        --metadata models/data/urban_safety/metadata.csv \
        --data-root models \
        --model-dir arduino/uno_q/model \
        --out arduino/uno_q/test_sounds
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

THIS = Path(__file__).resolve()
APP_ROOT = THIS.parents[1]
sys.path.insert(0, str(APP_ROOT / "python"))

from edge.config import SAFETY_CLASSES  # noqa: E402
from edge.engine import ModelRunner  # noqa: E402
from edge.features import LogMel  # noqa: E402

SAMPLE_RATE = 16000


def load_waveform(path: Path, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Mono float32, peak-normalized and resampled (matches models.data.load_waveform)."""
    import soundfile as sf
    from scipy.signal import resample_poly

    data, sr = sf.read(str(path), dtype="float32", always_2d=False)
    data = np.asarray(data, dtype=np.float32)
    if data.ndim > 1:
        data = data.mean(axis=1)
    peak = float(np.abs(data).max()) if data.size else 0.0
    if peak > 0:
        data = data / peak
    if sr != sample_rate:
        data = resample_poly(data, sample_rate, sr).astype(np.float32)
    return data


def clip_probs(
    runner: ModelRunner, logmel: LogMel, wave: np.ndarray, win: int, hop: int
) -> tuple[np.ndarray, float]:
    """Mean urban softmax and mean safety probability over a clip's 1 s windows."""
    if wave.shape[0] < win:
        wave = np.pad(wave, (0, win - wave.shape[0]))
    starts = range(0, wave.shape[0] - win + 1, hop)
    inferences = [runner.infer(logmel(wave[s : s + win])) for s in starts]
    urban = np.mean(np.stack([inf.urban_probs for inf in inferences]), axis=0)
    safety = float(np.mean([inf.safety_prob for inf in inferences]))
    return urban, safety


@dataclass
class Result:
    path: str
    class_name: str
    fold: int
    pred: str
    confidence: float
    safety_prob: float

    @property
    def correct(self) -> bool:
        return self.pred == self.class_name


def read_metadata(csv_path: Path, data_root: Path) -> dict[str, list[tuple[Path, int]]]:
    """class_name -> [(resolved path, fold)]."""
    by_class: dict[str, list[tuple[Path, int]]] = defaultdict(list)
    with open(csv_path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            raw = Path(row["path"])
            path = raw if raw.is_absolute() else data_root / raw
            if path.exists():
                by_class[row["class_name"]].append((path, int(row["fold"])))
            elif "filename" in row:
                fallback = path.parent / row["filename"]
                if fallback.exists():
                    by_class[row["class_name"]].append((fallback, int(row["fold"])))
    return by_class


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metadata", default="models/data/urban_safety/metadata.csv")
    parser.add_argument("--data-root", default="models")
    parser.add_argument("--model-dir", default="arduino/uno_q/model")
    parser.add_argument("--out", default="arduino/uno_q/test_sounds")
    parser.add_argument("--per-class", type=int, default=40, help="candidates evaluated per class")
    parser.add_argument("--test-fold", type=int, default=10, help="held-out fold preferred for the demo")
    parser.add_argument("--win-seconds", type=float, default=1.0)
    parser.add_argument("--hop-seconds", type=float, default=1.0)
    args = parser.parse_args()

    runner = ModelRunner.from_dir(Path(args.model_dir) / "model.onnx")
    logmel = LogMel(n_mels=runner.meta.n_mels, target_frames=runner.meta.frames)
    win, hop = int(args.win_seconds * SAMPLE_RATE), int(args.hop_seconds * SAMPLE_RATE)

    by_class = read_metadata(Path(args.metadata), Path(args.data_root))
    rng = np.random.default_rng(0)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    import soundfile as sf

    manifest: dict[str, dict] = {}
    print(f"{'class':<15}{'cand':>5}{'ok':>5}{'held-out':>10}   pick")
    print("-" * 72)

    for class_name in runner.meta.class_names:
        items = list(by_class.get(class_name, []))
        rng.shuffle(items)
        items.sort(key=lambda it: it[1] != args.test_fold)  # held-out first
        items = items[: args.per_class]

        results: list[Result] = []
        for path, fold in items:
            try:
                wave = load_waveform(path)
            except Exception as exc:  # noqa: BLE001
                print(f"  skip {path.name}: {exc}")
                continue
            probs, safety = clip_probs(runner, logmel, wave, win, hop)
            idx = int(np.argmax(probs))
            results.append(
                Result(
                    path=str(path),
                    class_name=class_name,
                    fold=fold,
                    pred=runner.meta.class_names[idx],
                    confidence=float(probs[idx]),
                    safety_prob=safety,
                )
            )

        correct = [r for r in results if r.correct]
        held_out = [r for r in correct if r.fold == args.test_fold]
        if not correct:
            print(f"{class_name:<15}{len(results):>5}{0:>5}{0:>10}   <no working clip>")
            continue

        best = max(held_out or correct, key=lambda r: r.confidence)
        wave = load_waveform(Path(best.path))
        dest = out_dir / f"{class_name}.wav"
        sf.write(str(dest), wave, SAMPLE_RATE, subtype="PCM_16")
        manifest[class_name] = {
            **asdict(best),
            "held_out": best.fold == args.test_fold,
            "is_safety": class_name in SAFETY_CLASSES,
            "output": dest.name,
        }
        print(
            f"{class_name:<15}{len(results):>5}{len(correct):>5}"
            f"{(str(len(held_out)) + ' yes') if held_out else 'no':>10}   "
            f"{best.confidence:.2f}  {Path(best.path).name[:38]}"
        )

    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    missing = [c for c in runner.meta.class_names if c not in manifest]
    print("-" * 72)
    print(f"wrote {len(manifest)} clips to {out_dir}")
    if missing:
        print(f"MISSING (no working clip): {', '.join(missing)}")


if __name__ == "__main__":
    main()
