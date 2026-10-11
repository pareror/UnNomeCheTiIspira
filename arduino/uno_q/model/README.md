# model/

Deployable model bundle consumed by the runtime (see `tools/prepare_model.py`).
Generated files are git-ignored; only this README is tracked.

Expected contents after running the preparation tool:

| file | what it is |
|------|------------|
| `model.onnx` (+ `model.onnx.data`) | DS-CNN exported from the trained checkpoint |
| `model_int8.onnx` | optional static-INT8 model (with `--int8`) |
| `model_meta.json` | `class_names`, `norm_mean`/`norm_std`, `frames`, `n_mels`, `embedding_dim` |

`model_meta.json` carries the normalization statistics the ONNX graph does not
contain — the runtime applies `(logmel - norm_mean) / (norm_std + 1e-5)` before
inference.

Generate it from `models/`:

```bash
python arduino/uno_q/tools/prepare_model.py \
  --checkpoint models/artifacts/ds_cnn_urban_safety.pt \
  --out arduino/uno_q/model \
  --int8 --calib-cache models/data/urban_safety_features.pt
```

`model_int8.onnx` is picked up automatically in preference to `model.onnx`.
To deploy a `.tflite` instead, convert with `onnx2tf` (see
`models/src/acoustic_models/export.py`) and drop `model.tflite` here; the
runtime auto-detects it.
