# ESC-50 metrics

- test fold: 5 (train on the other 4)
- generator: esc50, 1s windows, log-mel 40x49, seed=0, epochs=30

## Classifier (DS-CNN, 50 classes)

- params: 16467
- window accuracy: 0.4755
- window macro-F1: 0.4480
- clip accuracy: 0.6025
- clip macro-F1: 0.5583
- test clips: 400

## Anomaly (normal=natural vs anomalous=urban)

- test windows: 400 normal / 400 anomalous
- autoencoder params: 4801

| detector | AUROC |
|---|---|
| gaussian_mahalanobis | 0.4826 |
| knn_feature_bank | 0.4580 |
| autoencoder_recon | 0.4781 |

**best: gaussian_mahalanobis (AUROC 0.4826)**
