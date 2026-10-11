import torch

from acoustic_models.ds_cnn import DSCNN


def test_forward_shapes():
    model = DSCNN(n_mels=40, n_urban=8)
    urban, safety, embedding = model(torch.randn(4, 1, 40, 49))
    assert urban.shape == (4, 8)
    assert safety.shape == (4,)
    assert embedding.shape == (4, 64)


def test_parameter_budget():
    # The on-device budget is <= ~100k params (docs section 3).
    assert DSCNN().num_parameters() < 100_000
