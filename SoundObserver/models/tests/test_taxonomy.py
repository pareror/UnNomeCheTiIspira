from acoustic_models import esc50, urbansound8k


def test_us8k_taxonomy():
    assert len(urbansound8k.CLASS_NAMES) == 10
    assert urbansound8k.group_of("siren") == urbansound8k.ANOMALOUS_GROUP
    assert urbansound8k.group_of("jackhammer") == urbansound8k.ANOMALOUS_GROUP
    assert urbansound8k.group_of("dog_bark") == urbansound8k.NORMAL_GROUP
    assert urbansound8k.group_of("street_music") == urbansound8k.NORMAL_GROUP


def test_esc50_taxonomy():
    names = {n for group in esc50.CLASS_GROUPS.values() for n in group}
    assert len(names) == 50
    assert esc50.group_of("rain") == esc50.NORMAL_GROUP
    assert esc50.group_of("siren") == esc50.ANOMALOUS_GROUP
    assert esc50.group_of("nonsense") == "unknown"
