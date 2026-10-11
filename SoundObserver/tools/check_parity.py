"""Verify the NumPy log-mel front-end matches the PyTorch reference.

Run in the models environment (needs torch):

    python SoundObserver/tools/check_parity.py

Exits non-zero if the maximum absolute difference exceeds ``--tol``.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

THIS = Path(__file__).resolve()
APP_ROOT = THIS.parents[1]
sys.path.insert(0, str(APP_ROOT / "models" / "src"))
sys.path.insert(0, str(APP_ROOT / "python"))

import torch  # noqa: E402

from acoustic_models.features import LogMel as TorchLogMel  # noqa: E402
from acoustic_models.features import mel_filterbank as torch_mel_filterbank  # noqa: E402
from edge.features import LogMel as NumpyLogMel  # noqa: E402
from edge.features import mel_filterbank as numpy_mel_filterbank  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tol", type=float, default=1e-4)
    parser.add_argument("--iters", type=int, default=5)
    args = parser.parse_args()

    fb_ref = torch_mel_filterbank(40, 512, 16000).numpy()
    fb_got = numpy_mel_filterbank(40, 512, 16000)
    fb_diff = float(np.max(np.abs(fb_ref - fb_got)))
    print(f"mel filterbank  max|diff| = {fb_diff:.3e}")

    ref = TorchLogMel()
    got = NumpyLogMel()

    worst = 0.0
    for it in range(args.iters):
        n = 16000 if it % 2 == 0 else 8000  # full 1 s window and a short one
        wave = np.random.default_rng(it).standard_normal(n).astype(np.float32)
        with torch.no_grad():
            y_ref = ref(torch.from_numpy(wave)).numpy()
        y_got = got(wave)
        diff = float(np.max(np.abs(y_ref - y_got)))
        worst = max(worst, diff)
        print(f"iter {it}: n={n:5d} shape={y_got.shape} max|diff| = {diff:.3e}")

    ok = max(worst, fb_diff) <= args.tol
    print(f"\nworst max|diff| = {max(worst, fb_diff):.3e} (tol {args.tol:.0e}) -> "
          f"{'PASS' if ok else 'FAIL'}")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
