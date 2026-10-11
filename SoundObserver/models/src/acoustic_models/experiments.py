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

from acoustic_models import esc50, freesound_dataset, urban_safety, urbansound8k
from acoustic_models.anomaly import TinyAutoencoder
from acoustic_models.ds_cnn import DSCNN

DATASETS = {"esc50": esc50, "us8k": urbansound8k, "urban_safety": urban_safety, "freesound_safety": freesound_dataset}


def get_features(dataset: str, data_root: str, cache_path: str) -> dict:
    module = DATASETS[dataset]
    if os.path.exists(cache_path):
        print(f"loading cached features: {cache_path}")
        blob = torch.load(cache_path, weights_only=False)
    else:
        if dataset == "us8k":
            module.download(data_root)
        elif dataset == "esc50" and not os.path.isdir(os.path.join(data_root, "ESC-50-master")):
            module.download(data_root)
        elif dataset in ("urban_safety", "freesound_safety"):
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


def to_binary(blob: dict, normal_group: str) -> dict:
    """Collapse the taxonomy to binary ordinary (0) vs non-ordinary (1)."""
    group = np.asarray(blob["group"])
    mask = (group == normal_group) | (group == blob["anomalous_group"])
    out = dict(blob)
    out["X"] = blob["X"][mask]
    for key in ("fold", "clip_id", "class_name", "group"):
        out[key] = np.asarray(blob[key])[mask]
    out["y"] = (out["group"] != normal_group).astype(int)
    out["class_names"] = ["ordinary", "non-ordinary"]
    return out


def _clone_state(model: torch.nn.Module) -> dict:
    return {k: v.detach().clone() for k, v in model.state_dict().items()}


def train_classifier(
    blob: dict,
    test_fold: int,
    epochs: int,
    batch: int,
    lr: float,
    seed: int,
    patience: int = 10,
    val_frac: float = 0.1,
    save_path: str | None = None,
) -> dict:
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    X, y, fold, clip_id = blob["X"], blob["y"], blob["fold"], blob["clip_id"]
    n_classes = len(blob["class_names"])

    if "split" in blob:
        split = np.asarray(blob["split"])
        tr = np.where(split == "train")[0]
        val = np.where(split == "val")[0]
        te = np.where(split == "test")[0]
    else:
        tr_all = np.where(fold != test_fold)[0]
        te = np.where(fold == test_fold)[0]

        # Hold out validation clips (not windows) so all windows of a clip stay on
        # the same side of the split.
        train_clips = np.unique(clip_id[tr_all])
        perm = rng.permutation(len(train_clips))
        n_val = max(1, int(len(train_clips) * val_frac))
        val_clips = set(train_clips[perm[:n_val]].tolist())
        is_val = np.array([c in val_clips for c in clip_id[tr_all]])
        val = tr_all[is_val]
        tr = tr_all[~is_val]

    # Normalization stats from a subsample of the training windows, and per-batch
    # normalization, so we never materialize a full-size copy of X.
    sub = tr[rng.integers(0, len(tr), size=min(4096, len(tr)))]
    mu = float(X[sub].mean())
    scale = 1.0 / (float(X[sub].std()) + 1e-5)

    def normalize(idx: np.ndarray) -> torch.Tensor:
        return (X[idx] - mu) * scale

    model = DSCNN(n_mels=X.shape[2], n_urban=n_classes)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    ytr = torch.from_numpy(y[tr]).long()
    yval = torch.from_numpy(y[val]).long()

    best_loss, best_state, best_epoch, bad, epochs_run = float("inf"), None, 0, 0, 0
    for epoch in range(epochs):
        model.train()
        order = torch.randperm(len(tr))
        total = 0.0
        for i in range(0, len(tr), batch):
            sel = order[i : i + batch].numpy()
            logits, _safety, _emb = model(normalize(tr[sel]))
            loss = F.cross_entropy(logits, ytr[order[i : i + batch]])
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            total += loss.item() * len(sel)
        train_loss = total / len(tr)

        model.eval()
        with torch.no_grad():
            vlogits, _safety, _emb = model(normalize(val))
            val_loss = float(F.cross_entropy(vlogits, yval))
            val_acc = float((vlogits.argmax(1) == yval).float().mean())

        epochs_run = epoch + 1
        improved = val_loss < best_loss - 1e-4
        if improved:
            best_loss, best_state, best_epoch, bad = val_loss, _clone_state(model), epochs_run, 0
        else:
            bad += 1
        print(
            f"  epoch {epochs_run}/{epochs}  train_loss={train_loss:.4f}  "
            f"val_loss={val_loss:.4f}  val_acc={val_acc:.4f}{'  *' if improved else ''}"
        )
        if bad >= patience:
            print(f"  early stop at epoch {epochs_run} (best epoch {best_epoch})")
            break

    if best_state is not None:
        model.load_state_dict(best_state)

    model.eval()
    prob_chunks = []
    with torch.no_grad():
        for i in range(0, len(te), batch):
            logits, _safety, _emb = model(normalize(te[i : i + batch]))
            prob_chunks.append(torch.softmax(logits, dim=1))
    probs = torch.cat(prob_chunks).numpy()

    y_te = y[te]
    window_acc = accuracy_score(y_te, probs.argmax(1))
    window_f1 = f1_score(y_te, probs.argmax(1), average="macro", zero_division=0)

    clip_probs, cids = _clip_level(probs, clip_id[te])
    clip_labels = np.array([y[te][clip_id[te] == c][0] for c in cids])
    clip_acc = accuracy_score(clip_labels, clip_probs.argmax(1))
    clip_f1 = f1_score(clip_labels, clip_probs.argmax(1), average="macro", zero_division=0)
    cm = confusion_matrix(clip_labels, clip_probs.argmax(1), labels=np.arange(n_classes))

    result = {
        "params": model.num_parameters(),
        "window_accuracy": float(window_acc),
        "window_macro_f1": float(window_f1),
        "clip_accuracy": float(clip_acc),
        "clip_macro_f1": float(clip_f1),
        "confusion_matrix": cm.tolist(),
        "class_names": blob["class_names"],
        "test_fold": test_fold,
        "n_test_clips": int(len(cids)),
        "epochs_run": int(epochs_run),
        "best_epoch": int(best_epoch),
        "best_val_loss": float(best_loss),
    }
    if n_classes == 2:
        # Probability of the positive class ("non-ordinary").
        result["roc_auc"] = float(roc_auc_score(y_te, probs[:, 1]))

    if save_path:
        os.makedirs(os.path.dirname(save_path) or ".", exist_ok=True)
        torch.save(model.state_dict(), save_path)
        result["model_path"] = save_path
    return result


def _auroc(normal_scores: np.ndarray, anomalous_scores: np.ndarray) -> float:
    y_true = np.r_[np.zeros(len(normal_scores)), np.ones(len(anomalous_scores))]
    return float(roc_auc_score(y_true, np.r_[normal_scores, anomalous_scores]))


def run_anomaly(
    blob: dict,
    test_fold: int,
    epochs: int,
    batch: int,
    lr: float,
    seed: int,
    patience: int = 10,
    val_frac: float = 0.1,
    save_path: str | None = None,
) -> dict:
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    X, fold, group, clip_id = blob["X"], blob["fold"], blob["group"], blob["clip_id"]

    normal = group == blob["normal_group"]
    anomalous = group == blob["anomalous_group"]

    if "split" in blob:
        split = np.asarray(blob["split"])
        tr = np.where(normal & (split == "train"))[0]
        val = np.where(normal & (split == "val"))[0]
        te_n = np.where(normal & (split == "test"))[0]
        te_a = np.where(anomalous & (split == "test"))[0]
    else:
        tr_all = np.where(normal & (fold != test_fold))[0]
        te_n = np.where(normal & (fold == test_fold))[0]
        te_a = np.where(anomalous & (fold == test_fold))[0]

        # Hold out validation clips (not windows) for early stopping.
        train_clips = np.unique(clip_id[tr_all])
        perm = rng.permutation(len(train_clips))
        n_val = max(1, int(len(train_clips) * val_frac))
        val_clips = set(train_clips[perm[:n_val]].tolist())
        is_val = np.array([c in val_clips for c in clip_id[tr_all]])
        val = tr_all[is_val]
        tr = tr_all[~is_val]

    # Per-batch normalization + a bounded subsample for the density/kNN fits,
    # to keep memory and time in check on a large dataset.
    sub = tr[rng.integers(0, len(tr), size=min(4096, len(tr)))]
    mu = float(X[sub].mean())
    scale = 1.0 / (float(X[sub].std()) + 1e-5)

    def normalize(idx: np.ndarray) -> torch.Tensor:
        return (X[idx] - mu) * scale

    def flat_np(idx: np.ndarray) -> np.ndarray:
        return normalize(idx).reshape(len(idx), -1).numpy()

    fit_idx = tr[rng.permutation(len(tr))[: min(len(tr), 6000)]]
    f_fit = flat_np(fit_idx)
    n_comp = min(128, f_fit.shape[1], f_fit.shape[0] - 1)
    pca = PCA(n_components=n_comp, random_state=seed).fit(f_fit)
    z_fit = pca.transform(f_fit)
    del f_fit

    detectors: dict[str, float] = {}

    # 1) Gaussian density (Mahalanobis distance).
    cov = EmpiricalCovariance().fit(z_fit)
    z_n, z_a = pca.transform(flat_np(te_n)), pca.transform(flat_np(te_a))
    detectors["gaussian_mahalanobis"] = _auroc(cov.mahalanobis(z_n), cov.mahalanobis(z_a))

    # 2) kNN feature bank.
    nn = NearestNeighbors(n_neighbors=5).fit(z_fit)
    detectors["knn_feature_bank"] = _auroc(
        nn.kneighbors(z_n)[0].mean(1), nn.kneighbors(z_a)[0].mean(1)
    )
    del z_fit, z_n, z_a

    # 3) Autoencoder reconstruction error (early-stopped on normal-only validation).
    model = TinyAutoencoder(n_mels=X.shape[2])
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    best_loss, best_state, best_epoch, bad, epochs_run = float("inf"), None, 0, 0, 0
    for epoch in range(epochs):
        model.train()
        order = torch.randperm(len(tr))
        total = 0.0
        for i in range(0, len(tr), batch):
            sel = order[i : i + batch].numpy()
            xb = normalize(tr[sel])
            rec = model(xb)
            loss = torch.mean((rec - xb) ** 2)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            total += loss.item() * len(sel)
        train_loss = total / len(tr)

        model.eval()
        with torch.no_grad():
            xval = normalize(val)
            val_loss = float(torch.mean((model(xval) - xval) ** 2))

        epochs_run = epoch + 1
        improved = val_loss < best_loss - 1e-6
        if improved:
            best_loss, best_state, best_epoch, bad = val_loss, _clone_state(model), epochs_run, 0
        else:
            bad += 1
        print(
            f"  epoch {epochs_run}/{epochs}  train_mse={train_loss:.5f}  "
            f"val_mse={val_loss:.5f}{'  *' if improved else ''}"
        )
        if bad >= patience:
            print(f"  early stop at epoch {epochs_run} (best epoch {best_epoch})")
            break

    if best_state is not None:
        model.load_state_dict(best_state)

    model.eval()
    err_n = model.reconstruction_error(normalize(te_n)).numpy()
    err_a = model.reconstruction_error(normalize(te_a)).numpy()
    detectors["autoencoder_recon"] = _auroc(err_n, err_a)

    saved_ae: str | None = None
    if save_path:
        os.makedirs(os.path.dirname(save_path) or ".", exist_ok=True)
        torch.save(model.state_dict(), save_path)
        saved_ae = save_path

    best = max(detectors, key=detectors.get)
    return {
        "detectors": detectors,
        "best_detector": best,
        "best_auroc": detectors[best],
        "ae_params": model.num_parameters(),
        "ae_epochs_run": int(epochs_run),
        "ae_best_epoch": int(best_epoch),
        "n_normal_test": int(len(te_n)),
        "n_anomalous_test": int(len(te_a)),
        "normal_group": blob["normal_group"],
        "anomalous_group": blob["anomalous_group"],
        "test_fold": test_fold,
        "model_path": saved_ae,
    }


def write_reports(reports_dir: str, metrics: dict) -> None:
    os.makedirs(reports_dir, exist_ok=True)
    with open(os.path.join(reports_dir, "metrics.json"), "w") as fh:
        json.dump(metrics, fh, indent=2)

    clf, anom = metrics["classifier"], metrics["anomaly"]
    n_classes = len(clf["class_names"])
    lines = [
        "# Audio model metrics",
        "",
        f"- generator: {metrics['meta']}",
        f"- test fold: {clf['test_fold']} (held out)",
        "",
        f"## Classifier (DS-CNN, {n_classes} classes)",
        "",
        f"- params: {clf['params']}",
        f"- epochs run: {clf['epochs_run']} (best {clf['best_epoch']}; early stopping)",
        f"- window accuracy: {clf['window_accuracy']:.4f}",
        f"- window macro-F1: {clf['window_macro_f1']:.4f}",
        f"- clip accuracy: {clf['clip_accuracy']:.4f}",
        f"- clip macro-F1: {clf['clip_macro_f1']:.4f}",
        f"- test clips: {clf['n_test_clips']}",
        "",
        "### Per-class accuracy (clip level)",
        "",
        "| class | accuracy |",
        "|---|---|",
    ]
    if "roc_auc" in clf:
        for i, line in enumerate(lines):
            if line.startswith("- test clips:"):
                lines.insert(i + 1, f"- ROC-AUC (non-ordinary): {clf['roc_auc']:.4f}")
                break
    cm = np.asarray(clf["confusion_matrix"], dtype=float)
    with np.errstate(invalid="ignore", divide="ignore"):
        per_class = np.divide(np.diag(cm), cm.sum(1), out=np.zeros(len(cm)), where=cm.sum(1) > 0)
    for name, acc in zip(clf["class_names"], per_class):
        lines.append(f"| {name} | {acc:.3f} |")

    lines += [
        "",
        f"## Anomaly (normal={anom['normal_group']} vs anomalous={anom['anomalous_group']})",
        "",
        f"- test windows: {anom['n_normal_test']} normal / {anom['n_anomalous_test']} anomalous",
        f"- autoencoder params: {anom['ae_params']} (epochs {anom['ae_epochs_run']}, best {anom['ae_best_epoch']})",
        "",
        "| detector | AUROC |",
        "|---|---|",
    ]
    for name, value in anom["detectors"].items():
        lines.append(f"| {name} | {value:.4f} |")
    lines += ["", f"**best: {anom['best_detector']} (AUROC {anom['best_auroc']:.4f})**", ""]
    lines += [
        "## Saved weights",
        "",
        f"- classifier: {clf.get('model_path')}",
        f"- anomaly autoencoder: {anom.get('model_path')}",
        "",
    ]
    with open(os.path.join(reports_dir, "metrics.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print(f"wrote {os.path.join(reports_dir, 'metrics.md')}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", choices=list(DATASETS), default="us8k")
    parser.add_argument("--data-root", default=None)
    parser.add_argument("--cache", default=None)
    parser.add_argument("--reports", default="reports")
    parser.add_argument("--save-dir", default="artifacts", help="where to save trained weights")
    parser.add_argument("--test-fold", type=int, default=None)
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--patience", type=int, default=10)
    parser.add_argument("--val-frac", type=float, default=0.1)
    parser.add_argument("--task", choices=["multiclass", "binary"], default="multiclass")
    parser.add_argument("--batch", type=int, default=64)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    if args.data_root is None:
        args.data_root = {
            "esc50": "data/esc50",
            "us8k": "data/urbansound8k",
            "urban_safety": "data",
            "freesound_safety": "data",
        }[args.dataset]
    if args.cache is None:
        args.cache = f"data/{args.dataset}_features.pt"
    if args.test_fold is None:
        args.test_fold = 5 if args.dataset == "esc50" else 10

    blob = get_features(args.dataset, args.data_root, args.cache)
    if args.task == "binary":
        blob = to_binary(blob, blob["normal_group"])
    print(f"features: {tuple(blob['X'].shape)}  classes: {len(blob['class_names'])}")

    clf_path = os.path.join(args.save_dir, f"ds_cnn_{args.dataset}_{args.task}.pt")
    ae_path = os.path.join(args.save_dir, f"anomaly_ae_{args.dataset}.pt")

    print("training classifier ...")
    t0 = time.time()
    classifier = train_classifier(
        blob, args.test_fold, args.epochs, args.batch, args.lr, args.seed,
        args.patience, args.val_frac, clf_path,
    )
    print(f"  done in {time.time() - t0:.1f}s  -> {clf_path}")

    print("training anomaly model ...")
    t0 = time.time()
    anomaly = run_anomaly(
        blob, args.test_fold, args.epochs, args.batch, args.lr, args.seed,
        args.patience, args.val_frac, ae_path,
    )
    print(f"  done in {time.time() - t0:.1f}s  -> {ae_path}")

    metrics = {
        "meta": (
            f"{args.dataset}, task={args.task}, 1s windows, log-mel 40x49, seed={args.seed}, "
            f"max_epochs={args.epochs}, patience={args.patience}, val_frac={args.val_frac}"
        ),
        "classifier": classifier,
        "anomaly": anomaly,
    }
    write_reports(args.reports, metrics)
    print(json.dumps({"classifier": {k: v for k, v in classifier.items() if k != "confusion_matrix"},
                      "anomaly": anomaly}, indent=2))


if __name__ == "__main__":
    main()
