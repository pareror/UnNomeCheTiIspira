import numpy as np
import torch

from acoustic_models.anomaly import KNNFeatureBank, RollingStats, TinyAutoencoder


def test_rolling_stats_flags_outlier():
    rng = np.random.default_rng(0)
    stats = RollingStats(8)
    stats.partial_fit(rng.normal(0, 1, size=(200, 8)))

    normal_score = stats.score(rng.normal(0, 1, size=8))
    outlier_score = stats.score(np.full(8, 50.0))
    assert outlier_score > normal_score


def test_knn_bank_flags_outlier():
    rng = np.random.default_rng(0)
    bank = KNNFeatureBank(k=5).fit(rng.normal(0, 1, size=(100, 16)))

    normal_score = bank.score(np.zeros(16))
    outlier_score = bank.score(np.full(16, 20.0))
    assert outlier_score > normal_score


def test_autoencoder_shapes_error_and_train_step():
    model = TinyAutoencoder(n_mels=40)
    x = torch.randn(2, 1, 40, 49)

    rec = model(x)
    assert rec.shape == x.shape

    error = model.reconstruction_error(x)
    assert error.shape == (2,)

    optimizer = torch.optim.SGD(model.parameters(), lr=0.01)
    loss = torch.mean((model(x) - x) ** 2)
    optimizer.zero_grad()
    loss.backward()
    optimizer.step()
    assert torch.isfinite(loss)
