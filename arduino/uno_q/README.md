# Urban Acoustic Sensor — Arduino UNO Q (4 GB)

Runs the project's TinyML urban-noise + safety classifier on the **Arduino UNO
Q**, splitting the work across its two processors:

- **Qualcomm QRB2210 (Debian Linux, 4 GB)** — audio capture, log-mel front-end,
  DS-CNN inference, novelty baseline and the edge decision logic (Python).
- **STM32U585 (Cortex-M33)** — real-time signalling LED and status log, driven
  from Python through the Arduino **Bridge** (RouterBridge RPC).

Only compact semantics leave the node: one `NoiseSample` per second (amplitude +
class) and typed `EdgeEvent` lines on transitions. No raw audio is transmitted,
matching `docs/system-architecture-model.md`.

```
16 kHz window (1 s) ─▶ log-mel 40×49 ─▶ DSCNN ─┬─ urban logits ─┐
                                               ├─ safety logit  ├─▶ decision logic ─▶ LED (Bridge)
                                               └─ embedding ────┘         │
                                                     │                    └─▶ telemetry / events (stdout)
                              RollingStats novelty ──┘
```

## 1. Layout

```
arduino/uno_q/
├── app.yaml               App Lab manifest
├── requirements.txt       Linux-side Python deps (numpy, onnxruntime)
├── python/
│   ├── main.py            App Lab entry point + runtime loop
│   └── edge/              numpy port of models/src/acoustic_models
│       ├── features.py    log-mel front-end (parity-checked vs torch)
│       ├── engine.py      ONNX / TFLite runner + model metadata
│       ├── anomaly.py     unsupervised "normal" baseline (rolling stats)
│       ├── decision.py    hysteresis / smoothing -> LED + event flags
│       ├── audio.py       WAV replay + USB-mic capture, framing, dBFS
│       └── config.py      runtime config + class taxonomy
├── sketch/                STM32U585 sketch (LED + Bridge callbacks)
├── model/                 deployable model bundle (see model/README.md)
├── test_sounds/           curated 16 kHz clips, one per class (pitch demo)
└── tools/
    ├── prepare_model.py   checkpoint -> ONNX/TFLite + model_meta.json
    ├── check_parity.py    verify the numpy front-end against PyTorch
    └── build_test_sounds.py  evaluate clips, pick one working sound per class
```

## 2. Prepare the model

The trained checkpoint `models/artifacts/ds_cnn_urban_safety.pt` carries the
class names and log-mel normalization the ONNX graph does not. Export the bundle
(run from `models/`, in an environment with torch):

```bash
python arduino/uno_q/tools/prepare_model.py \
  --checkpoint models/artifacts/ds_cnn_urban_safety.pt \
  --out arduino/uno_q/model \
  --int8 --calib-cache models/data/urban_safety_features.pt
```

This writes `arduino/uno_q/model/model.onnx`, an optional `model_int8.onnx`, and
`model_meta.json`. The runtime prefers `model_int8.onnx`, then `model.onnx`,
then `model.tflite`.

## 3. Run

**In App Lab** — open `arduino/uno_q/` as the app folder and press *Run*. App Lab
installs `requirements.txt` into the app environment; the sketch is flashed to the
STM32 side automatically.

**Standalone (on the board or a desktop, for testing)**:

```bash
pip install -r requirements.txt
EDGE_SOURCE=wav EDGE_WAV=/path/to/clip.wav python python/main.py --model-dir model
```

Options / environment variables:

| flag | env | default | meaning |
|------|-----|---------|---------|
| `--model-dir` | `EDGE_MODEL_DIR` | `model/` | model bundle directory |
| `--model-file` | `EDGE_MODEL_FILE` | auto | force a specific model file |
| `--source` | `EDGE_SOURCE` | `wav` | `wav` (replay) or `mic` (USB sound card) |
| `--wav` | `EDGE_WAV` | — | WAV path when `source=wav` |
| — | `EDGE_USE_BRIDGE` | `1` | set `0` to skip Bridge/LED calls |

For a live microphone, use `--source mic` (requires a USB mic or sound card and
`sounddevice`). The UNO Q has no onboard mic; an I2S MEMS mic wired to the
STM32 side would instead be streamed over the Bridge.

## 4. Wiring the signalling LED

`sketch/sketch.ino` drives three active-high LEDs (or an RGB module) on pins
`D2=green`, `D3=amber`, `D4=red`; change the constants to match your board.

| LED state | meaning |
|-----------|---------|
| green | nominal |
| amber | noise novelty above threshold (`anomaly_on=0.6`) |
| red | safety event (`safety_prob ≥ 0.7`, e.g. scream / gunshot) |

Thresholds, smoothing window and the calibration length live in
`python/edge/config.py` (`DecisionConfig`, `RuntimeConfig.calibration_windows`)
and mirror `models/configs/default.yaml`.

## 5. Verify

```bash
# front-end parity with the PyTorch reference (needs torch)
python arduino/uno_q/tools/check_parity.py
```

## 6. Demo sounds (pitch)

`test_sounds/` holds one 16 kHz mono clip per class, each verified to classify
correctly through this runtime (held-out clips preferred). Replay any of them:

```bash
EDGE_WAV=arduino/uno_q/test_sounds/scream.wav \
  python arduino/uno_q/python/main.py --source wav \
  --wav arduino/uno_q/test_sounds/scream.wav --model-dir arduino/uno_q/model
```

Rebuild or refresh the set (evaluates labeled clips, keeps the best correct one
per class, writes `manifest.json`):

```bash
python arduino/uno_q/tools/build_test_sounds.py
```

## 7. Notes and alternatives

- **Runtime:** ONNX Runtime (CPU) on the Qualcomm side. If you prefer the
  intended MCU path, convert to INT8 TFLite (`onnx2tf`, see
  `models/src/acoustic_models/export.py`) and run it with
  `tflite_runtime`/`ai_edge_litert` here, or with **TFLite Micro** on the
  STM32U585 directly.
- **Novelty baseline:** `RollingStats` on the 64-D embedding (the "free",
  instant-warm-up method in the model spec §4.1). The score is squashed to
  0..1 via `score/(1+score)`; calibrate thresholds against the zone baseline.
- **Privacy:** raw audio stays on-node; only amplitude, class and events leave.
