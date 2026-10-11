# model/

Deployable model bundle consumed by the runtime (see `tools/prepare_model.py`).
The bundle (`model.onnx` + `model.onnx.data` + `model_meta.json`) is committed so
it ships with the app folder (Arduino App Lab syncs only tracked files to the board).

Expected contents after running the preparation tool:

| file | what it is |
|------|------------|
| `model.onnx` (+ `model.onnx.data`) | DS-CNN exported from the trained checkpoint |
| `model_int8.onnx` | optional static-INT8 model (with `--int8`) |
| `model_meta.json` | `class_names`, `norm_mean`/`norm_std`, `frames`, `n_mels`, `embedding_dim` |

`model_meta.json` carries the normalization statistics the ONNX graph does not
contain — the runtime applies `(logmel - norm_mean) / (norm_std + 1e-5)` before
inference.

Generate it from `SoundObserver/models/`:

```bash
python SoundObserver/tools/prepare_model.py \
  --checkpoint SoundObserver/models/artifacts/ds_cnn_urban_safety.pt \
  --out SoundObserver/model \
  --int8 --calib-cache SoundObserver/models/data/urban_safety_features.pt
```

`model_int8.onnx` is picked up automatically in preference to `model.onnx`.
To deploy a `.tflite` instead, convert with `onnx2tf` (see
`SoundObserver/models/src/acoustic_models/export.py`) and drop `model.tflite` here; the
runtime auto-detects it.
