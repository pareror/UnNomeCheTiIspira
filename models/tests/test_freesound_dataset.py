import os
import tempfile

import numpy as np
import scipy.io.wavfile as wavfile

from acoustic_models import freesound_dataset as fs


def _clip(name: str, class_name: str, recording: str, uploader: str, target: int | None = None) -> fs.Clip:
    return fs.Clip(
        filename=name,
        path=f"/tmp/{name}",
        target=fs.CLASS_TO_ID[class_name] if target is None else target,
        class_name=class_name,
        fold=0,
        safety_label=fs.safety_of(class_name),
        recording_id=recording,
        source="freesound",
        uploader=uploader,
        license="Creative Commons 0",
        license_url=fs.LICENSE_URLS["Creative Commons 0"],
        source_url="https://freesound.org/s/1/",
        duration=2.0,
    )


def test_taxonomy_and_safety():
    assert fs.CLASS_NAMES == [
        "scream", "gunshot", "siren", "car_horn",
        "construction", "traffic", "speech", "ambient_quiet",
    ]
    assert fs.safety_of("scream") == 1.0
    assert fs.safety_of("gunshot") == 1.0
    assert fs.safety_of("siren") == 0.0
    assert fs.group_of("siren") == fs.ANOMALOUS_GROUP
    assert fs.group_of("traffic") == fs.NORMAL_GROUP
    assert fs.group_of("scream") == "other"


def test_license_filter_syntax():
    flt = fs._license_filter(["Creative Commons 0", "Attribution"])
    assert flt == 'license:("Creative Commons 0" OR "Attribution")'


def test_config_has_all_classes():
    cfg = fs.load_config()
    assert set(fs.CLASS_NAMES) <= set(cfg["classes"])
    assert cfg["n_folds"] >= 2
    assert cfg["test_fold"] <= cfg["n_folds"]


def test_group_key_variants():
    c = _clip("a.wav", "scream", "fs:1", "alice")
    assert fs._group_key(c, "recording") == "fs:1"
    assert fs._group_key(c, "uploader") == "up:alice"
    assert fs._group_key(c, "uploader_class") == "scream:alice"


def test_assign_group_folds_never_splits_a_group():
    groups, labels = [], []
    for g in range(30):
        for _ in range(3):
            groups.append(f"g{g}")
            labels.append(g % 4)
    folds = fs.assign_group_folds(groups, labels, n_folds=5, n_classes=4, seed=1)
    assert set(folds) <= {1, 2, 3, 4, 5}
    per_group = {}
    for g, f in zip(groups, folds):
        per_group.setdefault(g, set()).add(f)
    assert all(len(v) == 1 for v in per_group.values())


def test_assign_group_folds_balances_classes():
    groups, labels = [], []
    for g in range(40):
        groups.append(f"g{g}")
        labels.append(g % 4)
    folds = fs.assign_group_folds(groups, labels, n_folds=4, n_classes=4, seed=3)
    # each class has 10 groups over 4 folds -> counts within +-2
    for cls in range(4):
        counts = [int((folds[(np.array(labels) == cls)] == f).sum()) for f in range(1, 5)]
        assert max(counts) - min(counts) <= 2


def test_md5_matches_content():
    with tempfile.TemporaryDirectory() as d:
        a = os.path.join(d, "a.bin")
        b = os.path.join(d, "b.bin")
        with open(a, "wb") as fh:
            fh.write(b"hello world")
        with open(b, "wb") as fh:
            fh.write(b"hello world")
        assert fs._md5(a) == fs._md5(b)


def test_metadata_and_manifest_roundtrip():
    clips = [
        _clip("1_a.mp3", "scream", "fs:1", "alice"),
        _clip("2_b.mp3", "siren", "fs:2", "bob"),
        _clip("3_c.mp3", "scream", "fs:3", "alice"),
    ]
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, fs.SUBDIR)
        os.makedirs(out)
        fs._write_metadata(clips, fs.Path(out))
        fs._write_attribution(clips, fs.Path(out))
        digest = fs._write_manifest(fs.Path(out))
        assert len(digest) == 64
        assert os.path.exists(os.path.join(out, "attribution.md"))

        loaded = fs.load_clips(d)
        assert len(loaded) == 3
        assert {c.class_name for c in loaded} == {"scream", "siren"}
        assert loaded[0].recording_id == "fs:1"
        assert loaded[0].license == "Creative Commons 0"


def test_verify_disjoint_splits_detects_group_leak():
    # 10 train clips (fold 1) + 2 test clips (fold 10). Clips never span folds.
    clip_id = np.arange(12)
    fold = np.array([1] * 10 + [10, 10])

    # leaky: uploader "alice" appears in a train clip AND in a test clip
    groups_leak = np.array([f"scream:u{i}" for i in range(10)] + ["scream:u0", "scream:x"])
    leaky = {"clip_id": clip_id, "fold": fold, "group_name": groups_leak}
    res = fs.verify_disjoint_splits(leaky, test_fold=10)
    assert res["overlap_train_test"] == 0  # clip ids are still disjoint ...
    assert res["group_overlap_train_test"] + res["group_overlap_val_test"] > 0
    assert res["is_disjoint"] is False

    # clean: every group confined to one fold
    groups_clean = np.array([f"scream:u{i}" for i in range(12)])
    clean = {"clip_id": clip_id, "fold": fold, "group_name": groups_clean}
    res_clean = fs.verify_disjoint_splits(clean, test_fold=10)
    assert res_clean["is_disjoint"] is True
    assert res_clean["group_overlap_train_test"] == 0


def test_assemble_pipeline_offline(monkeypatch):
    """End-to-end assemble with stubbed network: search -> download -> dedup -> folds -> features."""
    counter = {"n": 0}

    def fake_search(token, query, lic_filter, page, page_size, delay):
        if page > 1:
            return {"results": []}
        results = []
        for _ in range(20):
            counter["n"] += 1
            sid = counter["n"]
            results.append({
                "id": sid,
                "name": f"sample {sid}",
                "license": "Creative Commons 0",
                "username": f"user{sid % 3}",
                "url": f"https://freesound.org/s/{sid}/",
                "previews": {"preview-hq-mp3": f"https://cdn.example/{sid}.wav"},
                "duration": 2.0,
            })
        return {"results": results}

    def fake_download(url, dest, retries=3):
        sid = int(url.rsplit("/", 1)[-1].split(".")[0])
        freq = 200 + (sid % 100) * 10  # distinct content per id, so dedup does not collapse them
        sr = 16000
        t = np.linspace(0, 1.0, sr, endpoint=False)
        wavfile.write(str(dest), sr, (0.5 * np.sin(2 * np.pi * freq * t)).astype(np.float32))

    monkeypatch.setattr(fs, "search_sounds", fake_search)
    monkeypatch.setattr(fs, "_download_file", fake_download)
    monkeypatch.setattr(fs, "_load_dotenv", lambda _p: None)
    monkeypatch.setenv("FREESOUND_API_KEY", "test-token")

    with tempfile.TemporaryDirectory() as d:
        clips = fs.assemble_dataset(d, max_per_class=4)
        assert len(clips) == 4 * len(fs.CLASS_NAMES)
        assert os.path.exists(os.path.join(d, fs.SUBDIR, "metadata.csv"))
        assert os.path.exists(os.path.join(d, fs.SUBDIR, "manifest.sha256"))
        assert {c.fold for c in clips} <= set(range(1, 11))

        blob = fs.build_blob(d)
        assert blob["X"].shape[1:] == (1, 40, 49)
        assert blob["class_names"] == fs.CLASS_NAMES
        stats = fs.verify_disjoint_splits(blob, test_fold=10)
        assert stats["is_disjoint"] is True
        assert stats["overlap_train_test"] == 0
        assert stats["group_overlap_train_test"] == 0
