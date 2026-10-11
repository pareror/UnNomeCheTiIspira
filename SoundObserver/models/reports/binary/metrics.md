# Audio model metrics

- generator: urban_safety, task=binary, 1s windows, log-mel 40x49, seed=0, max_epochs=30, patience=10, val_frac=0.1
- test fold: 10 (held out)

## Classifier (DS-CNN, 2 classes)

- params: 13347
- epochs run: 13 (best 3; early stopping)
- window accuracy: 0.7166
- window macro-F1: 0.7134
- clip accuracy: 0.7000
- clip macro-F1: 0.6983
- test clips: 80
- ROC-AUC (non-ordinary): 0.8378

### Per-class accuracy (clip level)

| class | accuracy |
|---|---|
| ordinary | 0.758 |
| non-ordinary | 0.660 |

## Anomaly (normal=normal vs anomalous=anomalous)

- test windows: 130 normal / 184 anomalous
- autoencoder params: 4801 (epochs 30, best 30)

| detector | AUROC |
|---|---|
| gaussian_mahalanobis | 0.7828 |
| knn_feature_bank | 0.7936 |
| autoencoder_recon | 0.7412 |

**best: knn_feature_bank (AUROC 0.7936)**

## Saved weights

- classifier: artifacts\ds_cnn_urban_safety_binary.pt
- anomaly autoencoder: artifacts\anomaly_ae_urban_safety.pt
