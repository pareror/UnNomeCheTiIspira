"""Train the tiny DS-CNN classifier (urban-noise + safety heads).

Trains the Depthwise-Separable CNN on log-mel features with two heads:
- Urban head: multi-class classification over the taxonomy (e.g. 9 classes in urban_safety)
- Safety head: binary logit for dangerous acoustic events (screams / gunshots)

Examples
--------
Smoke test (random data, no dataset needed):
    uv run python -m acoustic_models.train_classifier --smoke

Real training on Urban Safety dataset:
    uv run python -m acoustic_models.train_classifier --dataset urban_safety --epochs 30
"""

from __future__ import annotations

import argparse
import os
import time

import numpy as np
import torch
import torch.nn.functional as F
import yaml

from acoustic_models import esc50, freesound_dataset, urban_safety, urbansound8k
from acoustic_models.ds_cnn import DSCNN
from acoustic_models.export import export_classifier_onnx
from acoustic_models.features import LogMel

DATASETS = {
    "urban_safety": urban_safety,
    "freesound_safety": freesound_dataset,
    "us8k": urbansound8k,
    "esc50": esc50,
}


def random_waveforms(batch: int, seconds: float, sample_rate: int, device: str) -> torch.Tensor:
    n = int(seconds * sample_rate)
    return torch.randn(batch, n, device=device)


def train_smoke(steps: int = 5, batch: int = 8, lr: float = 1e-3, seed: int = 0) -> None:
    """Exercise the full forward/backward path on random data."""
    torch.manual_seed(seed)
    device = "cpu"
    logmel = LogMel().to(device)
    model = DSCNN(n_mels=40, n_urban=8).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)

    print(f"model parameters: {model.num_parameters()}")
    for step in range(steps):
        wave = random_waveforms(batch, 1.0, 16000, device)
        feats = logmel(wave)
        urban = torch.randint(0, 8, (batch,), device=device)
        safety = torch.randint(0, 2, (batch,), device=device).float()

        urban_logits, safety_logits, _ = model(feats)
        loss = F.cross_entropy(urban_logits, urban)
        loss = loss + F.binary_cross_entropy_with_logits(safety_logits, safety)

        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
        print(f"step {step + 1}/{steps}  loss={loss.item():.4f}")


def load_dataset_blob(dataset_name: str, data_root: str, cache_path: str | None = None) -> dict:
    module = DATASETS[dataset_name]
    if cache_path and os.path.exists(cache_path):
        print(f"loading cached features from {cache_path} ...")
        return torch.load(cache_path, weights_only=False)

    # Alternate check inside data_root
    alt_cache = os.path.join(data_root, f"{dataset_name}_features.pt")
    if os.path.exists(alt_cache):
        print(f"loading cached features from {alt_cache} ...")
        return torch.load(alt_cache, weights_only=False)

    print(f"assembling and featurizing {dataset_name} ...")
    module.download(data_root)
    blob = module.build_blob(data_root)
    if cache_path:
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        torch.save(blob, cache_path)
    return blob


def train_real(
    dataset_name: str = "urban_safety",
    data_root: str = "data",
    cache_path: str | None = None,
    epochs: int = 30,
    batch_size: int = 64,
    lr: float = 1e-3,
    patience: int = 10,
    val_frac: float = 0.1,
    test_fold: int = 10,
    seed: int = 42,
    out_checkpoint: str = "artifacts/ds_cnn_urban_safety.pt",
    export_onnx: str | None = "artifacts/ds_cnn_urban_safety.onnx",
) -> dict:
    """Train DSCNN with urban multiclass head and safety binary head."""
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)

    blob = load_dataset_blob(dataset_name, data_root, cache_path)
    X = blob["X"]  # (N, 1, 40, 49)
    y = blob["y"]  # (N,)
    fold = blob["fold"]
    clip_id = blob["clip_id"]
    class_names = blob["class_names"]
    n_classes = len(class_names)

    # Derive safety label (1.0 for scream and gunshot, 0.0 otherwise)
    if "safety" in blob:
        safety = blob["safety"]
    else:
        scream_idx = class_names.index("scream") if "scream" in class_names else -1
        gunshot_idx = class_names.index("gunshot") if "gunshot" in class_names else -1
        safety = np.array([1.0 if lab in (scream_idx, gunshot_idx) else 0.0 for lab in y], dtype=np.float32)

    if "split" in blob:
        split = np.asarray(blob["split"])
        tr = np.where(split == "train")[0]
        val = np.where(split == "val")[0]
        te = np.where(split == "test")[0]
    else:
        tr_all = np.where(fold != test_fold)[0]
        te = np.where(fold == test_fold)[0]

        # Hold out validation clips (not individual windows)
        train_clips = np.unique(clip_id[tr_all])
        perm = rng.permutation(len(train_clips))
        n_val = max(1, int(len(train_clips) * val_frac))
        val_clips = set(train_clips[perm[:n_val]].tolist())
        is_val = np.array([c in val_clips for c in clip_id[tr_all]])
        val = tr_all[is_val]
        tr = tr_all[~is_val]

    # Compute mean and standard deviation from training set
    mu, sd = float(X[tr].mean()), float(X[tr].std())
    normalize = lambda tensor: (tensor - mu) / (sd + 1e-5)

    Xtr = normalize(X[tr])
    ytr = torch.from_numpy(y[tr]).long()
    str_labels = torch.from_numpy(safety[tr]).float()

    Xval = normalize(X[val])
    yval = torch.from_numpy(y[val]).long()
    sval_labels = torch.from_numpy(safety[val]).float()

    model = DSCNN(n_mels=X.shape[2], n_urban=n_classes)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)

    print(f"training DSCNN ({model.num_parameters()} parameters) on {len(tr)} windows, validating on {len(val)} ...")
    best_loss, best_state, best_epoch, bad = float("inf"), None, 0, 0
    best_acc = 0.0

    for epoch in range(1, epochs + 1):
        model.train()
        order = torch.randperm(len(tr))
        total_loss, total_u_loss, total_s_loss = 0.0, 0.0, 0.0

        for i in range(0, len(tr), batch_size):
            idx = order[i : i + batch_size]
            u_logits, s_logits, _ = model(Xtr[idx])

            u_loss = F.cross_entropy(u_logits, ytr[idx])
            s_loss = F.binary_cross_entropy_with_logits(s_logits, str_labels[idx])
            loss = u_loss + 2.0 * s_loss

            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

            total_loss += loss.item() * len(idx)
            total_u_loss += u_loss.item() * len(idx)
            total_s_loss += s_loss.item() * len(idx)

        train_loss = total_loss / len(tr)

        model.eval()
        with torch.no_grad():
            vu_logits, vs_logits, _ = model(Xval)
            vu_loss = F.cross_entropy(vu_logits, yval)
            vs_loss = F.binary_cross_entropy_with_logits(vs_logits, sval_labels)
            val_loss = float(vu_loss + 2.0 * vs_loss)
            val_acc = float((vu_logits.argmax(1) == yval).float().mean())
            scream_preds = (torch.sigmoid(vs_logits) > 0.5).float()
            val_safety_recall = (
                float((scream_preds[sval_labels == 1.0] == 1.0).float().mean())
                if (sval_labels == 1.0).any()
                else 1.0
            )

        improved = val_loss < best_loss - 1e-4
        if improved:
            best_loss = val_loss
            best_acc = val_acc
            best_epoch = epoch
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
            bad = 0
        else:
            bad += 1

        print(
            f"  epoch {epoch:02d}/{epochs:02d} | train={train_loss:.4f} | "
            f"val_loss={val_loss:.4f} val_acc={val_acc:.4f} safety_recall={val_safety_recall:.3f}"
            f"{'  *' if improved else ''}"
        )

        if bad >= patience:
            print(f"  early stopping triggered at epoch {epoch} (best epoch: {best_epoch})")
            break

    # Save best model checkpoint
    if best_state is not None:
        model.load_state_dict(best_state)

    os.makedirs(os.path.dirname(out_checkpoint), exist_ok=True)
    checkpoint = {
        "model_state_dict": model.state_dict(),
        "n_urban": n_classes,
        "class_names": class_names,
        "frames": int(X.shape[-1]),
        "win_seconds": float(blob.get("win_seconds", 5.0 if X.shape[-1] > 100 else 1.0)),
        "norm_mean": mu,
        "norm_std": sd,
        "best_epoch": best_epoch,
        "best_val_loss": best_loss,
        "best_val_acc": best_acc,
        "params": model.num_parameters(),
    }
    torch.save(checkpoint, out_checkpoint)
    print(f"\n[OK] Trained model checkpoint saved -> {out_checkpoint}")

    # Export to ONNX if requested
    if export_onnx:
        os.makedirs(os.path.dirname(export_onnx), exist_ok=True)
        export_classifier_onnx(export_onnx, n_urban=n_classes, frames=int(X.shape[-1]), weights_path=out_checkpoint)
        print(f"[OK] ONNX model exported -> {export_onnx}")

    return checkpoint


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="configs/default.yaml", help="config YAML path")
    parser.add_argument("--dataset", default="urban_safety", choices=list(DATASETS), help="dataset key")
    parser.add_argument("--data-root", default="data", help="dataset folder")
    parser.add_argument("--cache", default="data/urban_safety_features.pt", help="feature cache path")
    parser.add_argument("--epochs", type=int, default=30, help="number of training epochs")
    parser.add_argument("--batch", type=int, default=64, help="batch size")
    parser.add_argument("--lr", type=float, default=1e-3, help="learning rate")
    parser.add_argument("--patience", type=int, default=10, help="early stopping patience")
    parser.add_argument("--out", default="artifacts/ds_cnn_urban_safety.pt", help="checkpoint path")
    parser.add_argument("--export-onnx", default="artifacts/ds_cnn_urban_safety.onnx", help="onnx path")
    parser.add_argument("--smoke", action="store_true", help="run on random data")
    parser.add_argument("--steps", type=int, default=5)
    args = parser.parse_args()

    if args.smoke:
        train_smoke(steps=args.steps)
        return

    train_real(
        dataset_name=args.dataset,
        data_root=args.data_root,
        cache_path=args.cache,
        epochs=args.epochs,
        batch_size=args.batch,
        lr=args.lr,
        patience=args.patience,
        out_checkpoint=args.out,
        export_onnx=args.export_onnx,
    )


if __name__ == "__main__":
    main()
