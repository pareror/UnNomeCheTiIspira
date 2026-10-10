# Audio model metrics

- generator: urban_safety, 1s windows, log-mel 40x49, seed=0, max_epochs=3, patience=10, val_frac=0.1
- test fold: 10 (held out)

## Classifier (DS-CNN, 9 classes)

- params: 13802
- epochs run: 3 (best 3; early stopping)
- window accuracy: 0.4500
- window macro-F1: 0.3689
- clip accuracy: 0.4190
- clip macro-F1: 0.3869
- test clips: 105

### Per-class accuracy (clip level)

| class | accuracy |
|---|---|
| scream | 1.000 |
| gunshot | 0.000 |
| siren | 0.312 |
| traffic | 0.571 |
| speech | 0.250 |
| car_horn | 0.545 |
| construction | 0.750 |
| impact_crash | 0.000 |
| ambient_quiet | 0.143 |

## Anomaly (normal=normal vs anomalous=anomalous)

- test windows: 174 normal / 226 anomalous
- autoencoder params: 4801 (epochs 3, best 3)

| detector | AUROC |
|---|---|
| gaussian_mahalanobis | 0.7526 |
| knn_feature_bank | 0.8089 |
| autoencoder_recon | 0.7194 |

**best: knn_feature_bank (AUROC 0.8089)**
