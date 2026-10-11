import torch

from acoustic_models.features import LogMel


def test_output_shape():
    lm = LogMel()
    out = lm(torch.randn(2, 16000))
    assert out.shape == (2, 1, 40, 49)


def test_accepts_1d_waveform():
    lm = LogMel()
    out = lm(torch.randn(16000))
    assert out.shape == (1, 1, 40, 49)


def test_deterministic_and_finite():
    lm = LogMel()
    wav = torch.randn(1, 16000)
    a, b = lm(wav), lm(wav)
    assert torch.allclose(a, b)
    assert torch.isfinite(a).all()
