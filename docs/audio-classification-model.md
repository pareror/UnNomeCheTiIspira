# Audio Classification Model — Real-Time 1-Second Sound Analysis (Sub-€7 MCU)

Model specification for the on-node classifier that analyzes **1-second audio clips in real time** and classifies them, running **entirely on a microcontroller** with a **≤ €7** budget. Companion to [`system-architecture-model.md`](./system-architecture-model.md) (§4 Edge AI Models).

## 1. Decision: reuse a TinyML-scale model (not a large backbone)

Two constraints drive the decision:

1. *"Design only if not already available online"* → reuse existing architectures.
2. *"The model must stay on a ≤ €7 MCU"* → a **TinyML-scale** model only. Large AudioSet backbones **cannot run on-node in real time** at this budget and are excluded from the device.

| Need | Available online? | Action |
|------|-------------------|--------|
| On-MCU audio classifier | **Yes** — DS-CNN (MLPerf Tiny reference), small log-mel CNN (ESC-50 / RP2040 reference), Edge Impulse-generated models | **Reuse architecture** |
| Urban-noise taxonomy | **Yes** — SONYC-UST / DCASE Urban Sound Tagging | Reuse class taxonomy |
| Large audio backbones (YAMNet / PANNs / AST / BEATs) | **Yes**, but ~MB-scale | **Off-device only** — use as *teachers* (see §8) |
| Critical sounds ("cry for help") | **Partial** — research repos | Train a tiny head |
| Contextual noise-anomaly scoring | **No turnkey model** | Cheap statistical detector (§4) |

**Consequence:** the **network architecture is not designed from scratch**. We reuse a TinyML reference architecture (DS-CNN-class) and train its weights for our taxonomy. The big pretrained models move to a server-side **distillation** role.

## 2. Hardware budget (≤ €7)

| MCU | Core / clock | RAM | Radio (for the mesh) | ML fit | Cost |
|-----|--------------|-----|----------------------|--------|------|
| **ESP32-S3** | dual LX7 @240 MHz (+SIMD) | 512 KB SRAM (+opt. 8 MB PSRAM) | Wi-Fi + BLE | **Best** — tens of ms per INT8 model | ~€3–6 |
| **ESP32-C3** | single RV32 @160 MHz | 400 KB SRAM | Wi-Fi + BLE | Good — smaller models | ~€2–3 |
| **ESP32 (classic)** | dual @240 MHz | 520 KB SRAM | Wi-Fi + BLE | Good | ~€2–4 |
| **nRF52840** | M4F @64 MHz | 256 KB RAM / 1 MB flash | BLE + 802.15.4 (Thread/Zigbee) | Moderate — low clock | ~€5–8 |
| **RP2040** | dual M0+ @133 MHz | 264 KB SRAM | **None** (needs external radio) | Moderate; radio gap | ~€4 |
| **STM32F103** | M3 @72 MHz | 20–64 KB RAM | None | Weak | ~€2 |
| ~~Arduino Uno/Nano (ATmega328P)~~ | 16 MHz | **2 KB SRAM** | None | **Not viable** — cannot hold the model | ~€3–5 |

**Recommendation:** **ESP32-S3** — best ML throughput (vector instructions, ~300 KB INT8 models in SRAM, PSRAM headroom) *and* an integrated Wi-Fi/BLE radio for the mesh. **ESP32-C3** if cost dominates; **nRF52840** if Thread/Zigbee mesh and battery life dominate. Classic Arduino boards are out.

> Note: the €7 covers the **MCU/board**; the MEMS microphone, power, and enclosure are additional.

## 3. On-device model budget

| Budget | Target |
|--------|--------|
| Parameters | ≤ ~100 k |
| INT8 model size | ≤ ~100 KB (hard cap ~300 KB in ESP32-S3 SRAM) |
| Input | 1 s @ 16 kHz → log-mel ≈ **40 mel × 49 frames** |
| Inference latency | **< 1 s hop** (typical ESP32 @240 MHz: 10–200 ms) |
| Tensor arena | fits SRAM with FreeRTOS + app; PSRAM only if unavoidable (10–20× slower, +30–50 % power) |

## 4. Selected tiny model

A **DS-CNN-style depthwise-separable CNN** on a log-mel input — the standard TinyML audio architecture:

```
1 s audio @16 kHz ─▶ on-device log-mel (40×49) ─▶ DS-CNN trunk
                                                     │
                              ┌──────────────────────┼───────────────────────┐
                              ▼                      ▼                        ▼
                    Head A: urban-noise      Head B: safety           Anomaly detector
                    (multi-class softmax)    (scream/help, binary)    (statistical, not NN)
```

- **Backbone**: depthwise-separable convolutions (as in the DS-CNN / MLPerf Tiny keyword-spotting reference and the ESC-50 tinyML CNN), INT8-quantized. Reused architecture — only weights are custom.
- **Head A — urban-noise classifier**: multi-class softmax over the **SONYC-UST coarse taxonomy** (engine, machinery-impact, non-machinery-impact, powered-saw, alert-signal, music, human-voice, dog) plus local ordinance classes.
- **Head B — safety classifier**: binary **scream / cry-for-help**, trained with class weighting and a recall-oriented threshold.
- **Anomaly detector**: **self-taught, unsupervised** — learns the zone's "normal" from unlabeled local audio (see §4.1). Not a classifier; keeps the on-device budget free.

If RAM allows only one head, collapse A and B into a **single multi-class head** whose classes include the safety class.

### 4.1 Learning the zone's "normal" (short-term, unsupervised)

**Yes — and it should be the first thing the node does.** Teaching "this is normal" from the local soundscape is a standard *unsupervised* task: **anomalous sound detection (ASD) trained on normal-only audio** (see DCASE Task 2). No labels are needed, and it adapts **short-term** (seconds → days).

Keep two notions of "normal" separate — they answer different questions:

| Notion | Meaning | How it's obtained | Produces |
|--------|---------|-------------------|----------|
| **Statistical normal** | Typical background for *this zone/time-slot* | Unsupervised, from local audio | Novelty score — "something is off" |
| **Legal normal** | Within ordinance limits | Fixed reference (dB limits + taxonomy) | Compliance — "is it a violation" |

> **Critical caveat:** a model that only learns the local soundscape will treat a **permanently noisy venue as "normal"** and never flag it. So the novelty detector must be paired with an **absolute reference** (legal dB thresholds + the supervised classifier). Novelty is relative; compliance is absolute.

Methods — all **normal-only, no anomaly labels**:

| Method | Learns in | On-MCU cost | Notes |
|--------|-----------|-------------|-------|
| Rolling statistics (per zone + time-slot) | seconds–minutes | **Free** | Mean/variance of level + log-mel; instant warm-up |
| kNN on an embedding feature bank | minutes–hours | Very cheap | Store normal embeddings; distance = novelty; trivial online update |
| Tiny autoencoder (reconstruction error) | hours–days | Cheap inference | conv-SPAD-style; train centrally, quantize, OTA |
| Self-supervised embedding + density/threshold | hours–days | Cheap inference | Learn normal via SSL; score by distance |

**Short-term timeline**

1. **Install calibration** — record a few minutes on site → initial baseline + threshold.
2. **Warm-up (hours–day)** — refine rolling stats; populate the normal feature bank (kNN).
3. **Steady state** — online threshold adaptation; periodic central retrain + OTA for the AE.

**On-device training?** Full backprop on a ≤ €7 MCU is possible but heavy (e.g. TinyProp sparse backprop, incremental transfer + kNN). Prefer **online adaptation of baseline/thresholds and a kNN feature bank** on-device (no gradient training), with **central retraining** for the autoencoder. That delivers "learn normal in the short period" within budget.

**Day/night & drift** — make the baseline **time-slot aware** and add slow forgetting so it tracks season/street changes without gradually accepting real violations.

## 5. Input pipeline (on-MCU)

- MEMS mic → **16 kHz mono**, normalize to `[-1, 1]`.
- **1 s window**, hop 1 s (matches 1 Hz telemetry); optional 0.5 s hop for a smoother LED.
- **Log-mel front end computed on the MCU** (CMSIS-DSP / ESP-DSP): ~25 ms window, ~10 ms hop → ~40 mel × ~49 frames.
- Ring buffer holds the last 1 s; inference runs per hop.

## 6. Outputs & decision logic

- **Class output** (Head A): top class + probability → `EdgeEvent` (`class`, `confidence`).
- **Safety output** (Head B): scream/help probability → high-priority `EdgeEvent`.
- **Anomaly score**: 0..1 → drives the **LED** and governance events.
- Post-processing: confidence thresholds, **debounce/hysteresis**, temporal smoothing (median over last N s), then map to LED state and events. Lives in the edge **Decision Logic**, not the model.

## 7. Deployment

- **Quantize to INT8** (full integer) with representative-dataset calibration; verify accuracy drop vs. float.
- Runtimes: **TensorFlow Lite Micro / LiteRT**, or **Edge Impulse** (generates deployable C++ for ESP32/nRF52 and handles arena sizing).
- Size the **tensor arena** explicitly; prefer SRAM, treat PSRAM as last resort.
- Measure end-to-end latency and peak RAM on the target board before finalizing.

## 8. Training via distillation from offline teachers

Because the big models can't run on-device, use them on a **server**:

1. **Collect** local field recordings from the deployed zones (domain-matched) + public sets (ESC-50, UrbanSound8K, SONYC-UST).
2. **Pseudo-label** with offline teachers (YAMNet / PANNs / SONYC models) and/or human labels.
3. **Train the tiny on-device model** — either fine-tune the reused DS-CNN architecture, or **knowledge-distill** the teacher's soft outputs into it.
4. **Augment**: background urban noise, SNR variation, time/frequency masking, gain.
5. **Quantize → validate → OTA** deploy (see architecture §9).

**Datasets**: ESC-50, UrbanSound8K, SONYC-UST, AudioSet (via teacher), local recordings.
**Metrics**: per-class recall (safety classes recall-first), false-positive rate, macro-F1; calibrate thresholds against the zone baseline.

## 9. What still needs to be built (small, no new architecture)

1. Trained **urban-noise head** (local taxonomy) on the reused DS-CNN architecture.
2. Trained **safety head** for screams / cries for help.
3. **Anomaly detector** (statistical baseline).
4. Edge **decision logic** (thresholds, hysteresis, LED/event mapping).
5. **Distillation + quantization + OTA** pipeline.

## 10. References

- [Sound classification with YAMNet — TensorFlow Hub](https://www.tensorflow.org/hub/tutorials/yamnet) *(teacher)*
- [Transfer learning with YAMNet for environmental sound classification](https://www.tensorflow.org/tutorials/audio/transfer_learning_audio)
- [End-to-end tinyML audio classification with the Raspberry Pi RP2040 (TensorFlow blog)](https://blog.tensorflow.org/2021/09/TinyML-Audio-for-everyone.html)
- [TinyML keyword spotting (DS-CNN) — MLPerf Tiny / nRF Edge AI](https://nrfconnectdocs.nordicsemi.com/addons/addon-edge-ai/latest/axon_compiler/mlperf_tiny_models_kws.html)
- [Edge Impulse — Sound recognition](https://docs.edgeimpulse.com/tutorials/end-to-end/sound-recognition)
- [ESP32-S3 Edge AI in Practice — INT8, PSRAM trade-offs](https://zediot.com/blog/esp32-s3-tinyml-optimization/)
- [Embedded AI: Running TinyML on ESP32-S3 (512 KB SRAM → ~300 KB INT8 models)](https://electroniccomponent.com/embedded-ai-tinyml-esp32-s3-microcontroller/)
- [TinyML for Acoustic Anomaly Detection in IoT Sensor Networks (UrbanSound8K)](https://arxiv.org/html/2603.26135v1)
- [PANNs: Large-Scale Pretrained Audio Neural Networks](https://arxiv.org/pdf/1912.10211v3) *(teacher)*
- [SONYC-UST-V2: An Urban Sound Tagging Dataset](https://markcartwright.com/files/cartwright2020sonycustv2.pdf)
- [DCASE 2020 — Urban Sound Tagging with Spatiotemporal Context](https://dcase.community/challenge2020/task-urban-sound-tagging-with-spatiotemporal-context)
- [DCASE 2026 Task 2 — Unsupervised Anomalous Sound Detection (normal-only training)](https://dcase.community/challenge2026/task-first-shot-unsupervised-anomalous-sound-detection-for-machine-condition-monitoring)
- [Audio-based anomaly detection on edge devices via self-supervision (conv-SPAD)](https://link.springer.com/article/10.1007/s10844-023-00792-2)
- [TinyProp — Adaptive Sparse Backpropagation for TinyML on-device learning](https://arxiv.org/abs/2308.09201)
- [Incremental On-Device Tiny Machine Learning (transfer learning + kNN)](https://dlnext.acm.org/doi/pdf/10.1145/3417313.3429378)
- [Human scream detection (research example)](https://github.com/kd-abhidev/Human-scream-detection)

## 11. Open Questions

- Fitting two heads in the budget vs. one merged multi-class head.
- Achievable per-class recall on a ≤100 k-param INT8 model for the safety classes.
- ESP32-S3 vs. ESP32-C3 vs. nRF52840 — ML throughput vs. radio/mesh vs. power.
- Whether on-device log-mel (CMSIS-DSP/ESP-DSP) meets the hop with margin.
- Distillation cadence and OTA size limits for the fleet.
- Acceptable false-positive rate per zone for the safety threshold.
- **"Normal" learning**: which method (rolling stats vs. kNN feature bank vs. tiny autoencoder) per hardware tier?
- How long a calibration window is acceptable at install, and how to handle zones with unusual initial conditions.
- How to set the **absolute/legal reference** so relative novelty doesn't mask persistently noisy venues.
