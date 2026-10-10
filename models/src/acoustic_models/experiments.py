"""Run ESC-50 experiments: train, apply and measure metrics.

Two experiments, both on the official ESC-50 folds:

1. **Classifier** -- train the DS-CNN on 4 folds, evaluate on the held-out fold
   (window-level and clip-level accuracy / macro-F1).
2. **Anomaly**    -- train the tiny autoencoder on *natural* sounds only, then
   measure AUROC separating held-out natural (normal) from urban (anomalous).

Writes ``reports/metrics.json`` and ``reports/metrics.md``.

Example:
    uv run --no-sync python -m acoustic_models.experiments --epochs 30
"""

from __future__ import annotations

import argparse
import json
import os
import time

import numpy as np
import torch
import torch.nn.functional as F
from sklearn.covariance import EmpiricalCovariance
from sklearn.decomposition import PCA
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score, roc_auc_score
from sklearn.neighbors import NearestNeighbors

from acoustic_models import esc50, urbansound8k
from acoustic_models.anomaly import TinyAutoencoder
from acoustic_models.ds_cnn import DSCNN

DATASETS = {"esc50": esc50, "us8k": urbansound8k}


def get_features(dataset: str, data_root: str, cache_path: str) -> dict:
    module = DATASETS[dataset]
    if os.path.exists(cache_path):
        print(f"loading cached features: {cache_path}")
        blob = torch.load(cache_path, weights_only=False)
    else:
        if dataset == "us8k":
            module.download(data_root)
        elif not os.path.isdir(os.path.join(data_root, "ESC-50-master")):
            module.download(data_root)
        print(f"featurizing {dataset} ...")
        blob = module.build_blob(data_root)
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        torch.save(blob, cache_path)
    blob["normal_group"] = module.NORMAL_GROUP
    blob["anomalous_group"] = module.ANOMALOUS_GROUP
    return blob


def _clip_level(probs: np.ndarray, clip_ids: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Average window probabilities per clip; return (clip_probs, ordered_clip_ids)."""
    cids = np.unique(clip_ids)
    out = np.stack([probs[clip_ids == c].mean(axis=0) for c in cids])
    return out, cids


def train_classifier(blob: dict, test_fold: int, epochs: int, batch: int, lr: float, seed: int) -> dict:
    torch.manual_seed(seed)
    X, y, fold, clip_id = blob["X"], blob["y"], blob["fold"], blob["clip_id"]
    n_classes = len(blob["class_names"])

    tr = np.where(fold != test_fold)[0]
    te = np.where(fold == test_fold)[0]

    mu, sd = X[tr].mean(), X[tr].std()
    Xn = (X - mu) / (sd + 1e-5)

    model = DSCNN(n_mels=X.shape[2], n_urban=n_classes)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    Xtr = Xn[tr]
    ytr = torch.from_numpy(y[tr]).long()

    for epoch in range(epochs):
        model.train()
        perm = torch.randperm(len(tr))
        total = 0.0
        for i in range(0, len(tr), batch):
            idx = perm[i : i + batch]
            logits, _safety, _emb = model(Xtr[idx])
            loss = F.cross_entropy(logits, ytr[idx])
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            total += loss.item() * len(idx)
        if (epoch + 1) % max(1, epochs // 5) == 0:
            print(f"  epoch {epoch + 1}/{epochs}  loss={total / len(tr):.4f}")

    model.eval()
    with torch.no_grad():
        logits, _safety, _emb = model(Xn[te])
        probs = torch.softmax(logits, dim=1).numpy()

    y_te = y[te]
    window_acc = accuracy_score(y_te, probs.argmax(1))
    window_f1 = f1_score(y_te, probs.argmax(1), average="macro", zero_division=0)

    clip_probs, cids = _clip_level(probs, clip_id[te])
    # one label per clip id
    clip_labels = np.array([y[te][clip_id[te] == c][0] for c in cids])
    clip_acc = accuracy_score(clip_labels, clip_probs.argmax(1))
    clip_f1 = f1_score(clip_labels, clip_probs.argmax(1), average="macro", zero_division=0)
    cm = confusion_matrix(clip_labels, clip_probs.argmax(1), labels=np.arange(n_classes))

    return {
        "params": model.num_parameters(),
        "window_accuracy": float(window_acc),
        "window_macro_f1": float(window_f1),
        "clip_accuracy": float(clip_acc),
        "clip_macro_f1": float(clip_f1),
        "confusion_matrix": cm.tolist(),
        "class_names": blob["class_names"],
        "test_fold": test_fold,
        "n_test_clips": int(len(cids)),
    }


def _auroc(normal_scores: np.ndarray, anomalous_scores: np.ndarray) -> float:
    y_true = np.r_[np.zeros(len(normal_scores)), np.ones(len(anomalous_scores))]
    return float(roc_auc_score(y_true, np.r_[normal_scores, anomalous_scores]))


def run_anomaly(blob: dict, test_fold: int, epochs: int, batch: int, lr: float, seed: int) -> dict:
    torch.manual_seed(seed)
    X, fold, group = blob["X"], blob["fold"], blob["group"]

    normal = group == blob["normal_group"]
    anomalous = group == blob["anomalous_group"]
    tr = np.where(normal & (fold != test_fold))[0]
    te_n = np.where(normal & (fold == test_fold))[0]
    te_a = np.where(anomalous & (fold == test_fold))[0]

    mu, sd = X[tr].mean(), X[tr].std()
    Xn = (X - mu) / (sd + 1e-5)

    flat = Xn.reshape(Xn.shape[0], -1).numpy()
    f_tr, f_n, f_a = flat[tr], flat[te_n], flat[te_a]

    # Reduce dimension once; density/kNN detectors operate in this space.
    n_comp = min(128, f_tr.shape[1], f_tr.shape[0] - 1)
    pca = PCA(n_components=n_comp, random_state=seed).fit(f_tr)
    z_tr, z_n, z_a = pca.transform(f_tr), pca.transform(f_n), pca.transform(f_a)

    detectors: dict[str, float] = {}

    # 1) Gaussian density (Mahalanobis distance).
    cov = EmpiricalCovariance().fit(z_tr)
    detectors["gaussian_mahalanobis"] = _auroc(cov.mahalanobis(z_n), cov.mahalanobis(z_a))

    # 2) kNN feature bank.
    nn = NearestNeighbors(n_neighbors=5).fit(z_tr)
    detectors["knn_feature_bank"] = _auroc(
        nn.kneighbors(z_n)[0].mean(1), nn.kneighbors(z_a)[0].mean(1)
    )

    # 3) Autoencoder reconstruction error.
    model = TinyAutoencoder(n_mels=X.shape[2])
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    Xtr = Xn[tr]
    for epoch in range(epochs):
        model.train()
        perm = torch.randperm(len(tr))
        total = 0.0
        for i in range(0, len(tr), batch):
            idx = perm[i : i + batch]
            rec = model(Xtr[idx])
            loss = torch.mean((rec - Xtr[idx]) ** 2)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            total += loss.item() * len(idx)
        if (epoch + 1) % max(1, epochs // 5) == 0:
            print(f"  epoch {epoch + 1}/{epochs}  recon_mse={total / len(tr):.5f}")

    model.eval()
    err_n = model.reconstruction_error(Xn[te_n]).numpy()
    err_a = model.reconstruction_error(Xn[te_a]).numpy()
    detectors["autoencoder_recon"] = _auroc(err_n, err_a)

    best = max(detectors, key=detectors.get)
    return {
        "detectors": detectors,
        "best_detector": best,
        "best_auroc": detectors[best],
        "ae_params": model.num_parameters(),
        "n_normal_test": int(len(te_n)),
        "n_anomalous_test": int(len(te_a)),
        "normal_group": blob["normal_group"],
        "anomalous_group": blob["anomalous_group"],
        "test_fold": test_fold,
    }


def write_reports(reports_dir: str, metrics: dict) -> None:
    os.makedirs(reports_dir, exist_ok=True)
    with open(os.path.join(reports_dir, "metrics.json"), "w") as fh:
        json.dump(metrics, fh, indent=2)

    clf, anom = metrics["classifier"], metrics["anomaly"]
    lines = [
        "# ESC-50 metrics",
        "",
        f"- test fold: {clf['test_fold']} (train on the other 4)",
        f"- generator: {metrics['meta']}",
        "",
        "## Classifier (DS-CNN, 50 classes)",
        "",
        f"- params: {clf['params']}",
        f"- window accuracy: {clf['window_accuracy']:.4f}",
        f"- window macro-F1: {clf['window_macro_f1']:.4f}",
        f"- clip accuracy: {clf['clip_accuracy']:.4f}",
        f"- clip macro-F1: {clf['clip_macro_f1']:.4f}",
        f"- test clips: {clf['n_test_clips']}",
        "",
        f"## Anomaly (normal={anom['normal_group']} vs anomalous={anom['anomalous_group']})",
        "",
        f"- test windows: {anom['n_normal_test']} normal / {anom['n_anomalous_test']} anomalous",
        f"- autoencoder params: {anom['ae_params']}",
        "",
        "| detector | AUROC |",
        "|---|---|",
    ]
    for name, value in anom["detectors"].items():
        lines.append(f"| {name} | {value:.4f} |")
    lines += ["", f"**best: {anom['best_detector']} (AUROC {anom['best_auroc']:.4f})**", ""]
    with open(os.path.join(reports_dir, "metrics.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print(f"wrote {os.path.join(reports_dir, 'metrics.md')}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", choices=list(DATASETS), default="us8k")
    parser.add_argument("--data-root", default=None)
    parser.add_argument("--cache", default=None)
    parser.add_argument("--reports", default="reports")
    parser.add_argument("--test-fold", type=int, default=None)
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--batch", type=int, default=64)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    if args.data_root is None:
        args.data_root = {"esc50": "data/esc50", "us8k": "data/urbansound8k"}[args.dataset]
    if args.cache is None:
        args.cache = f"data/{args.dataset}_features.pt"
    if args.test_fold is None:
        args.test_fold = 5 if args.dataset == "esc50" else 10

    blob = get_features(args.dataset, args.data_root, args.cache)
    print(f"features: {tuple(blob['X'].shape)}  classes: {len(blob['class_names'])}")

    print("training classifier ...")
    t0 = time.time()
    classifier = train_classifier(blob, args.test_fold, args.epochs, args.batch, args.lr, args.seed)
    print(f"  done in {time.time() - t0:.1f}s")

    print("training anomaly model ...")
    t0 = time.time()
    anomaly = run_anomaly(blob, args.test_fold, args.epochs, args.batch, args.lr, args.seed)
    print(f"  done in {time.time() - t0:.1f}s")

    metrics = {
        "meta": (
            f"{args.dataset}, 1s windows, log-mel 40x49, "
            f"seed={args.seed}, epochs={args.epochs}"
        ),
        "classifier": classifier,
        "anomaly": anomaly,
    }
    write_reports(args.reports, metrics)
    print(json.dumps({"classifier": {k: v for k, v in classifier.items() if k != "confusion_matrix"},
                      "anomaly": anomaly}, indent=2))


if __name__ == "__main__":
    main()
