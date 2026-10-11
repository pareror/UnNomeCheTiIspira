from acoustic_models.train_anomaly import train_smoke as anomaly_smoke
from acoustic_models.train_classifier import train_smoke as classifier_smoke


def test_classifier_training_path_runs():
    classifier_smoke(steps=1, batch=4)


def test_anomaly_training_path_runs():
    anomaly_smoke(steps=1, batch=4)
