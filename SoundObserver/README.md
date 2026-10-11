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
SoundObserver/
├── app.yaml               App Lab manifest
├── pyproject.toml         uv project (dependencies + extras)
├── uv.lock                locked dependency set
├── requirements.txt       mirror of the deps for App Lab
├── python/
│   ├── main.py            App Lab entry point + runtime loop
│   ├── live_monitor.py    standalone real-time monitor (mic or WAV)
│   └── edge/              numpy port of SoundObserver/models/src/acoustic_models
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

The trained checkpoint `SoundObserver/models/artifacts/ds_cnn_urban_safety.pt` carries the
class names and log-mel normalization the ONNX graph does not. Export the bundle
(run from `SoundObserver/models/`, in an environment with torch):

```bash
python SoundObserver/tools/prepare_model.py \
  --checkpoint SoundObserver/models/artifacts/ds_cnn_urban_safety.pt \
  --out SoundObserver/model \
  --int8 --calib-cache SoundObserver/models/data/urban_safety_features.pt
```

This writes `SoundObserver/model/model.onnx`, an optional `model_int8.onnx`, and
`model_meta.json`. The runtime prefers `model_int8.onnx`, then `model.onnx`,
then `model.tflite`.

## 3. Run

### Environment (uv)

The app is a [uv](https://docs.astral.sh/uv/) project (`pyproject.toml` + `uv.lock`):

```bash
cd SoundObserver
uv sync                 # core runtime: numpy + onnxruntime
uv sync --all-extras    # + usb microphone, resampler, tflite backend, tooling
```

| extra | packages | for |
|-------|----------|-----|
| `mic` | sounddevice | live capture (`--source mic`) |
| `resample` | scipy | better resampling of non-16 kHz WAVs |
| `tflite` | ai-edge-litert | `.tflite` inference backend |
| `tools` | soundfile, scipy | `tools/build_test_sounds.py` |

`requirements.txt` mirrors the core/optional deps for App Lab (which manages its
own environment); `pyproject.toml` is the source of truth for uv. The
model-preparation tools (`tools/prepare_model.py`, `tools/check_parity.py`) need
torch, so run those from the `SoundObserver/models/` project.

### App Lab

Open `SoundObserver/` as the app folder and press *Run*. App Lab installs the
Python dependencies into the app environment; the sketch is flashed to the STM32
side automatically.

### Standalone (board or desktop)

```bash
uv run python/main.py --source wav --wav test_sounds/traffic.wav
uv run --extra mic python/live_monitor.py      # live microphone panel
```

### Model window (1 s vs 5 s)

The window length comes from `model_meta.json`, so the 5 s model works with no
code change — just point at its bundle:

```bash
uv run --extra mic python/live_monitor.py --model-dir model_5s
EDGE_MODEL_DIR=model_5s uv run python/main.py   # same for the App Lab entry
```

`model/` holds the 1 s model (`frames=49`), `model_5s/` the 5 s one (`frames=249`,
`win_seconds=5.0`). The runtime captures (or frames) the model's window length and
hops every `--hop` seconds. See `model_5s/README.md` for how it was built.

Options / environment variables:

| flag | env | default | meaning |
|------|-----|---------|---------|
| `--model-dir` | `EDGE_MODEL_DIR` | `model/` | model bundle directory |
| `--model-file` | `EDGE_MODEL_FILE` | auto | force a specific model file |
| `--source` | `EDGE_SOURCE` | `mic` | `mic` (jack/USB mic, default) or `wav` (replay) |
| `--wav` | `EDGE_WAV` | — | WAV path when `source=wav` |
| — | `EDGE_DEVICE` | default input | sounddevice input device index or name |
| — | `EDGE_HIGHPASS` | `100` | low-cut Hz before log-mel (`0` disables) |
| — | `EDGE_SILENCE_DBFS` | `-50` | below this level report `silence` and never alert |
| — | `EDGE_BG_MARGIN` | `8` | mic: dB above the noise floor to accept a window (`0` disables) |
| — | `EDGE_MIN_CONFIDENCE` | `0.6` | below this the class is reported as `uncertain` |
| — | `EDGE_USE_BRIDGE` | `1` | set `0` to skip Bridge/LED calls |
| — | `EDGE_SERVER_URL` | `http://192.168.22.103:3000` | master server base URL (danger-event POSTs) |
| — | `STATION_ID` | `ard-uno-q-real` | station id registered on the server |
| — | `STATION_NAME` | `Arduino Uno Q (Stazione Hardware)` | station display name |
| — | `LATITUDE` / `LONGITUDE` | `45.0566` / `7.6812` | station coordinates (radius filtering) |
| — | `SENSOR_API_KEY` | `arduino-torino-noise-secret-2026` | server sensor key (`x-api-key`) |
| — | `EDGE_REPORT_SAFETY` | `1` | set `0` to disable danger-event reporting |

Audio input defaults to `mic` (the 3.5 mm jack / USB sound card exposed to ALSA,
captured through `sounddevice`). List the inputs with `python/live_monitor.py
--list-devices` and select one with `--device`/`EDGE_DEVICE` if the default is not
the mic. Use `--source wav --wav <clip>` to replay a file instead.

### Danger events (server + OLED)

When the classifier raises the **safety** flag (scream/gunshot, `safety_prob ≥
0.7`), the node does three things on the rising edge — in addition to turning the
LED red:

1. **POSTs the event** to the master server (`POST {EDGE_SERVER_URL}/api/alerts/safety`
   with `x-api-key`), which forwards it to Telegram: subscribers whose venue is
   within their alert radius, plus law enforcement (`AUTHORITY_TELEGRAM_CHAT_IDS`
   on the server). The call is async (background thread, stdlib `urllib`), so the
   1 s loop is never blocked; failures are logged and retried.
2. **Pushes the string to the MCU** over the Bridge: `Bridge.call("show_event", "SCREAM 93%")`
   → the sketch shows it on the SSD1306 OLED for 10 s, then returns to `MONITOR OK`.
3. Emits `EdgeEvent.safety` on stdout as before.

Set `EDGE_REPORT_SAFETY=0` to keep it local (LED + OLED only).

### Live monitor (real time)

`python/live_monitor.py` loads the model, opens the microphone and redraws a
terminal panel every hop with the current classification, safety probability,
novelty and LED state:

```bash
cd SoundObserver

# live from the default input device
uv run --extra mic python/live_monitor.py

# choose an input device (see them with --list-devices)
uv run --extra mic python/live_monitor.py --list-devices
uv run --extra mic python/live_monitor.py --device 2

# no microphone? replay a clip on a loop
uv run python/live_monitor.py --source wav --wav test_sounds/scream.wav

# plain, line-per-hop output (logs / non-ANSI terminals)
uv run python/live_monitor.py --plain
```

Useful flags: `--top-k`, `--hop`, `--highpass`, `--silence-dbfs`, `--bg-margin`,
`--min-confidence`, `--calibration`, `--safety-threshold`,
`--anomaly-on/--anomaly-off`. Microphone capture needs the `mic` extra; WAV
replay needs only the core install.

### Input conditioning (low-cut)

The model was trained on clean, band-limited recordings, so it is sensitive to
low-frequency energy. A raw microphone adds DC offset and rumble/hum that the
classifier reads as the low-frequency ("traffic"/engine) class — which can mask
higher-frequency events such as a scream. Before the log-mel stage the runtime
applies a DC block plus a high-pass low-cut (`edge/preprocess.py`, `--highpass`,
default **100 Hz**):

```bash
# strong low-frequency noise in the environment? raise the low-cut
uv run --extra mic python/live_monitor.py --highpass 200

# disable the filter
uv run --extra mic python/live_monitor.py --highpass 0
```

Higher cutoffs favour higher-frequency events (scream, gunshot, glass, horn) at
the cost of some low-frequency classes (traffic, construction). The same low-cut
is applied by `tools/build_test_sounds.py`, so the curated clips are validated
under the runtime conditioning.

### Background & low-confidence guards

The model was trained on clean, band-limited clips and has **no "background"
class**, so a real microphone in a quiet room (low-level noise) gets forced onto
some label — most visibly `impact_crash`. Two guards keep the node quiet:

- **Background gate** (microphone only): a window within `background_margin_db`
  (default **8 dB**) of the running noise floor is treated as idle (`silence`).
  A leaky-minimum floor follows the ambient level, so a steady quiet room stays
  silent while a real event (well above the floor) is still classified.
- **Minimum confidence**: below `min_confidence` (default **0.6**) the class is
  reported as `uncertain` instead of forcing a label.

```bash
uv run --extra mic python/live_monitor.py                       # defaults
uv run --extra mic python/live_monitor.py --bg-margin 0         # disable the gate
uv run --extra mic python/live_monitor.py --min-confidence 0.7  # stricter
```

The proper fix is a retrain that adds quiet/background negatives (and the
inference low-cut) so quiet input maps to `ambient_quiet`/`silence` — see the
notes below.

## 4. Wiring the signalling LED

`sketch/sketch.ino` drives three active-high LEDs (or an RGB module) on pins
`D2=green`, `D3=amber`, `D4=red`; change the constants to match your board.

| LED state | meaning |
|-----------|---------|
| off | input below the silence threshold — no alert |
| green | nominal |
| amber | noise novelty above threshold (`anomaly_on=0.6`) |
| red | safety event (`safety_prob ≥ 0.7`, e.g. scream / gunshot) |

When the 1 s window is quieter than `silence_dbfs` (default **−50 dBFS**) the node
stays idle instead of classifying noise: it reports `class="silence"`, turns the
LED off and never raises an event, and any latched alarm/safety state is cleared.

Thresholds, smoothing window and the calibration length live in
`python/edge/config.py` (`DecisionConfig`, `RuntimeConfig.calibration_windows`)
and mirror `SoundObserver/models/configs/default.yaml`.

## 5. Verify

```bash
# front-end parity with the PyTorch reference (needs torch)
python SoundObserver/tools/check_parity.py
```

## 6. Demo sounds (pitch)

`test_sounds/` holds one 16 kHz mono clip per class, each verified to classify
correctly through this runtime (held-out clips preferred). Replay any of them:

```bash
EDGE_WAV=SoundObserver/test_sounds/scream.wav \
  python SoundObserver/python/main.py --source wav \
  --wav SoundObserver/test_sounds/scream.wav --model-dir SoundObserver/model
```

Rebuild or refresh the set (evaluates labeled clips, keeps the best correct one
per class, writes `manifest.json`):

```bash
python SoundObserver/tools/build_test_sounds.py
```

## 7. Notes and alternatives

- **Runtime:** ONNX Runtime (CPU) on the Qualcomm side. If you prefer the
  intended MCU path, convert to INT8 TFLite (`onnx2tf`, see
  `SoundObserver/models/src/acoustic_models/export.py`) and run it with
  `tflite_runtime`/`ai_edge_litert` here, or with **TFLite Micro** on the
  STM32U585 directly.
- **Novelty baseline:** `RollingStats` on the 64-D embedding (the "free",
  instant-warm-up method in the model spec §4.1). The score is squashed to
  0..1 via `score/(1+score)`; calibrate thresholds against the zone baseline.
- **Privacy:** raw audio stays on-node; only amplitude, class and events leave.
- **Exact conditioning:** the runtime low-cut is applied only at inference. For
  perfect train/serve consistency, add the same high-pass + DC removal to the
  training front-end (`acoustic_models/features.py`) and retrain.
