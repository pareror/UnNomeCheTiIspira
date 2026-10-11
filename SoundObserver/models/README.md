# Acoustic Models

TinyML models for the urban acoustic sensor network, plus the code to train and
export them. Everything here targets a **sub-7-EUR MCU** (ESP32-S3/C3 or
nRF52840); see [`../../docs/audio-classification-model.md`](../../docs/audio-classification-model.md)
for the specification.

## What's inside

| Module | What it is |
|--------|------------|
| `acoustic_models.features.LogMel` | Log-mel front-end (16 kHz, 1 s -> 40 mel x 49 frames), matching the on-MCU stage |
| `acoustic_models.ds_cnn.DSCNN` | Tiny depthwise-separable CNN with two heads: `urban` (multi-class) + `safety` (scream/help), plus a shared embedding |
| `acoustic_models.anomaly` | Unsupervised "normal" detectors: `RollingStats`, `KNNFeatureBank`, `TinyAutoencoder` |
| `acoustic_models.decision.DecisionLogic` | Edge post-processing: smoothing, hysteresis, LED state + event flags |
| `acoustic_models.teacher.TeacherSoftLabels` | Maps an offline teacher (YAMNet/PANNs) onto the student class space for distillation |
| `acoustic_models.data.LogMelDataset` | WAV dataset loader |
| `acoustic_models.train_classifier` / `train_anomaly` | Training entry points (with `--smoke` mode) |
| `acoustic_models.export` | PyTorch -> ONNX export, then TFLite INT8 |

Two things are kept deliberately separate (see docs section 4.1): **novelty**
(statistical "normal", learned locally and unsupervised) and **compliance**
(legal "normal", an absolute reference). The models emit novelty and safety
signals; the absolute/legal reference is applied upstream.

## Setup (uv)

Reuse the toolchain already on the machine (torch/numpy/scipy are large):

```bash
uv venv --system-site-packages
uv run --no-sync pytest
```

Or create a fully isolated environment (downloads torch):

```bash
uv sync --extra dev
uv run pytest
```

## Run the models

```bash
# smoke tests: exercise the full forward/backward path on random data
uv run --no-sync python -m acoustic_models.train_classifier --smoke
uv run --no-sync python -m acoustic_models.train_anomaly --smoke

# export for the MCU (writes ONNX + prints the TFLite INT8 steps)
uv run --no-sync python -m acoustic_models.export --out artifacts/
```

## Datasets & experiments

Supported datasets (both **CC BY-NC 3.0**, non-commercial):

| key | dataset | classes | role |
|-----|---------|---------|------|
| `urban_safety` | Urban Safety | 9 | curated safety taxonomy (scream, gunshot, siren, traffic, speech, ...) |
| `us8k` | UrbanSound8K | 10 | project taxonomy (engine, siren, jackhammer, ...) |
| `esc50` | ESC-50 | 50 | general benchmark |

Run the full pipeline (download -> featurize -> train -> evaluate):

```bash
uv run --no-sync python -m acoustic_models.experiments --dataset us8k --epochs 30
```

This writes `reports/metrics.json` and `reports/metrics.md`:

- **classifier** -- DS-CNN on the official folds (train 9, test fold 10): window/clip accuracy, macro-F1, confusion matrix.
- **anomaly** -- normal-only detectors (autoencoder reconstruction, kNN feature bank, Gaussian/Mahalanobis) scored by AUROC separating normal vs anomalous classes.

UrbanSound8K groups used for the anomaly task: `normal` = {air_conditioner, children_playing, dog_bark, street_music}; `anomalous` = {car_horn, drilling, engine_idling, gun_shot, jackhammer, siren}.

## Deployment path

```
PyTorch --torch.onnx.export--> ONNX --ai-edge-torch / onnx2tf--> TFLite INT8 --TFLite Micro--> MCU
```

Budget targets: <= ~100k params, <= ~100 KB INT8, inference < 1 s hop.
