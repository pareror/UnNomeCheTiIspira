# System Architecture Model — Urban Acoustic Sensor Network

Specification derived from [`README.md`](../README.md).

## 1. Purpose

A single sensor infrastructure with two objectives:

- **Noise governance** — detect anomalous urban noise, warn nearby businesses, and escalate to authorities when the anomaly persists.
- **Urban safety** — recognize critical sounds (e.g. cries for help) and locate their source through multi-sensor triangulation.

**Design stance: AI on the edge, connected by a mesh.** Detection and event signaling run *on the sensor node itself*. Nodes are deployed on a configurable **spacing `d`** (see the scale model in §6 — not fixed) and form a self-healing wireless **mesh** that relays each other's traffic toward a border router.

Two data paths travel the mesh, with different priorities:

- **Telemetry path** — every node reports the **sound amplitude once per second (1 Hz)** over the mesh, giving a per-node, per-zone **history of noise** upstream. Periodic, delay-tolerant, batched at the border router.
- **Event path** — time-critical semantic events (anomaly breach, critical sound). Low-latency, prioritized over telemetry.

Because inference is local, both paths stay tiny: telemetry is a single amplitude value per second, events are a few compact fields.

## 2. Architectural Overview

```
┌───────────────────────────────────────────────────────────────────────────┐
│                        EDGE AI MESH  (self-forming / self-healing)          │
│                                                                             │
│   Each node = Mic + Edge AI + Amplitude Sampler + LED + Mesh Radio          │
│                                                                             │
│          (N1)──────────(N2)──────────(N3)                                   │
│            │ ╲        ╱    ╲        ╱ │      ── peer mesh links              │
│            │   ╲    ╱        ╲    ╱   │      ── multi-hop routes            │
│          (N4)──────────(N5)──────────(N6)                                   │
│            │        ╲      ╱          │                                     │
│            └────────────(BR)──────────┘   BR = Border Router                │
│                          │                                                  │
│   Node roles: Sensing Node · Relay (router) · Border Router                 │
└──────────────────────────┼────────────────────────────────────────────────┘
                           ▼  backhaul (cellular / fiber)
┌───────────────────────────────────────────────────────────────────────────┐
│                       INGESTION LAYER                                       │
│   Telemetry Gateway ─▶ Time-Series Store  (1 Hz amplitude → noise history)  │
│   Event Gateway     ─▶ Edge Event Stream  (typed, time-indexed)            │
│   Model & Config Registry  ──(OTA over mesh)──▶  Edge Nodes                │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    FUSION / CENTRAL PROCESSING LAYER                       │
│   Event Fusion & Confidence Aggregation · Triangulation · Noise Analytics   │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                       ORCHESTRATION / POLICY LAYER                          │
│   Escalation Engine  ·  Notification Router  ·  Dispatch Coordinator        │
└───────────┬─────────────────────────┬───────────────────────┬──────────────┘
            ▼                         ▼                       ▼
┌───────────────────┐   ┌───────────────────────┐   ┌──────────────────────┐
│  Business         │   │  Authority Escalation │   │  Patrol Dispatch     │
│  Notification     │   │  Channel              │   │                      │
└───────────────────┘   └───────────────────────┘   └──────────────────────┘
```

## 3. Components

### 3.1 Edge AI Layer (runs on every sensor node)

| Component | Responsibility | Inputs | Outputs |
|-----------|----------------|--------|---------|
| **Acoustic Front-End** | Captures ambient audio continuously; samples at the model's required rate. | Ambient audio | Raw PCM frames |
| **Feature Extractor** | Converts PCM into model features (e.g. log-mel / MFCC), on-device. | PCM frames | Feature vectors |
| **Edge Inference Runtime** | Executes quantized models locally (TFLite Micro / ONNX Runtime / vendor NPU). | Feature vectors | Model outputs |
| **Anomaly Detector** (model) | Scores how far current noise deviates from the on-device contextual baseline (zone + time slot). | Feature vectors, rolling baseline | Anomaly score |
| **Critical-Sound Classifier** (model) | Recognizes danger-indicative sounds (cries for help, etc.). | Feature vectors | Class + confidence |
| **Amplitude Sampler** | Computes the sound amplitude (e.g. dB(A) / RMS) and emits **one `NoiseSample` per second**. | PCM frames | `NoiseSample` (1 Hz) |
| **Edge Decision Logic** | Applies debounce/confidence/hysteresis rules; decides local signaling and event emission. | Model outputs | State transitions, event triggers |
| **Local Signal Controller** | Drives the LED (and optional buzzer) immediately — no network round trip. | Edge decision state | LED / audio-visual signal |
| **Event Emitter** | Serializes semantic events and hands them to the mesh stack. | State transitions | `EdgeEvent` |
| **Telemetry Emitter** | Batches `NoiseSample`s and hands them to the mesh stack at low priority. | `NoiseSample` (1 Hz) | Batched telemetry frames |
| **Local Audio Buffer** (optional, privacy-gated) | Retains a short rolling clip for escalation evidence on confirmed critical events. | PCM frames, trigger | Evidence clip |

### 3.2 Mesh Networking Layer

| Component | Responsibility | Inputs | Outputs |
|-----------|----------------|--------|---------|
| **Mesh Stack** | Self-forming, self-healing multi-hop routing over the wireless links. | Events, telemetry, neighbor beacons | Routed frames |
| **Traffic Prioritization** | Prioritizes the event path over the telemetry path; batches telemetry to cut per-sample overhead. | Queued frames | Scheduled frames |
| **Sensing Node role** | Detects and signals locally; originates events and telemetry; relays when needed. | — | `EdgeEvent`, `NoiseSample` |
| **Relay (router) role** | Forwards neighbors' traffic toward the border router; extends range. | Mesh frames | Forwarded frames |
| **Border Router** | Mesh↔backend gateway; aggregates telemetry and events for the backhaul. | Mesh frames | Upstream telemetry + events |
| **Time Sync** | Distributes a mesh-wide clock so samples and triangulation timestamps align. | Root time source | Synced node clocks |
| **Mesh Security** | Link-layer encryption, node identity/authentication, key rotation. | Node credentials | Authorized mesh membership |

**Why a mesh here:** extended coverage without per-node backhaul, resilience (redundant paths, no single point of failure), and — because edge AI keeps payloads tiny — low-bandwidth/low-power radios become sufficient. Nodes keep detecting and signaling locally even if the mesh is partitioned.

### 3.3 Ingestion Layer

| Component | Responsibility | Inputs | Outputs |
|-----------|----------------|--------|---------|
| **Telemetry Gateway** | Receives batched 1 Hz amplitude samples; validates and writes them. | Telemetry frames | `NoiseSample` rows |
| **Time-Series Store** | Durable noise history, partitioned by node/zone/time slot; serves queries and analytics. | `NoiseSample` rows | Queryable history, aggregates |
| **Event Gateway** | Authenticates border routers/nodes, deduplicates, orders, forwards events. | `EdgeEvent` stream | Validated events |
| **Edge Event Stream** | Durable, typed, time-indexed event log. | Validated events | Queryable history |
| **Model & Config Registry** | Stores model artifacts, thresholds, per-zone config; pushes OTA updates across the mesh. | Model artifacts, config | Signed node updates |

### 3.4 Fusion / Central Processing Layer

| Component | Responsibility | Inputs | Outputs |
|-----------|----------------|--------|---------|
| **Noise Analytics** | Builds per-zone/time-slot baselines, reports, and trends from the noise history. | Time-series data | Baselines, reports |
| **Event Fusion & Confidence Aggregation** | Correlates events across nodes/zones and aggregates confidence. | Edge events | Fused incident |
| **Triangulation** | Locates a sound source via TDOA across ≥N nodes; accuracy is tied to baseline length and clock alignment (see §6). | Multi-node critical events | Estimated source location |

### 3.5 Orchestration / Policy Layer

| Component | Responsibility | Inputs | Outputs |
|-----------|----------------|--------|---------|
| **Escalation Engine** | Applies timing/persistence rules to decide the next action tier. | Fused incidents, history, elapsed duration | Tier decision (indicator / business / authority) |
| **Notification Router** | Delivers notifications to the correct recipients. | Tier decision, recipient registry | Dispatched notifications |
| **Dispatch Coordinator** | Alerts the nearest available patrol on a confirmed critical event. | Fused critical event + location | Patrol dispatch request |

### 3.6 External Actors

| Actor | Role | Interaction |
|-------|------|-------------|
| **Business operators (esercenti)** | Receive preventive alerts to intervene before sanctions apply. | Inbound notification |
| **Law enforcement / authorities** | Receive escalation when the anomaly persists despite warnings. | Inbound notification |
| **Nearby patrol** | Responds to critical-sound events. | Inbound dispatch request |
| **Citizens / patrons** | Observe the LED state and self-adjust behavior. | On-node visual indicator |

## 4. Edge AI Models

The on-device model must run on a **≤ €7 microcontroller** (e.g. ESP32-S3/C3, nRF52840) — see [`audio-classification-model.md`](./audio-classification-model.md) for the full spec.

| Model | Task | Approach | Runs on | Output |
|-------|------|----------|---------|--------|
| **Anomaly Detector** | Contextual noise anomaly | Unsupervised — learns the zone's "normal" from local audio (normal-only ASD); see model spec §4.1 | Node | `anomaly_score` (0..1) |
| **Critical-Sound Classifier** | Audio event detection / keyword spotting | Tiny **DS-CNN-style** CNN on log-mel, INT8 (reused arch; custom weights) | Node | `{class, confidence}` |
| **Fusion Model** (optional) | Cross-node confidence aggregation | Lightweight classifier / rules | Central | `incident_confidence` |

Large pretrained backbones (YAMNet/PANNs) do **not** run on-node; they act as **offline teachers** for distillation (see model spec §8).

**On-node budget targets** (≤ €7 MCU):

- Inference latency: **< 1 s hop** (typical ESP32 @240 MHz: 10–200 ms).
- Model footprint: **≤ ~100 k params / ≤ ~100 KB INT8** (hard cap ~300 KB in ESP32-S3 SRAM).
- Input: 1 s @ 16 kHz → log-mel ≈ 40 mel × 49 frames.
- Power: always-on sensing within the node's power envelope — including relay duty and 1 Hz telemetry.
- Robustness: operates under wind, traffic, and background-city noise (domain-shifted training data).

## 5. Noise Telemetry & History (1 Hz amplitude)

Every node measures sound amplitude (**e.g. dB(A) or RMS**) and reports **one sample per second**.

**Bandwidth envelope** (drives the mesh and storage choices) — aggregate figures scale with node count, which depends on spacing; see the **scale model in §6** for node-count, bandwidth, and storage estimates by spacing.

| Scope | Payload | Rate | Daily volume |
|-------|---------|------|--------------|
| Per node | ~12–40 B/sample | 1 Hz | ~1–3.5 MB/node/day |

**Retention & roll-up policy** (raw 1 Hz is bulky long-term):

| Tier | Resolution | Retention |
|------|------------|-----------|
| Raw | 1 s | e.g. 7–30 days |
| Rolled up | 1 min avg / min / max | e.g. 1 year |
| Archived | 1 h avg | Indefinite |

Notes:
- Telemetry is **delay-tolerant** and **batched** (e.g. 60 samples/minute) to cut per-frame overhead and radio wakeups.
- Telemetry is **lower priority** than the event path on the mesh.
- The same on-device processing that drives the LED also produces the amplitude, so no extra sensing cost.

## 6. Scale Model & Protocol Selection

Node spacing `d`, covered area `A`, and the 1 Hz sample rate drive fleet size, mesh load, and the best protocol. The figures below are **planning estimates** (regular-grid assumption); a street-linear roll-out uses `length / d` instead of `area / d²`. Spacing is a **design parameter** — the tables show its sensitivity, so the right protocol can be picked once `d` and `A` are set.

**Inputs**

- Sampling rate: 1 sample/s/node.
- Telemetry payload: ~12 B (compact binary) to ~40 B (framed).
- Events: bursty and rare — negligible for average load, but prioritized over telemetry.

### 6.1 Node Count vs. Spacing

| Spacing `d` | Nodes/km² | Nodes / 100×100 m block | Nodes / 100 km² | Border routers @ ~300 nodes/partition |
|---|---|---|---|---|
| 5 m | 40 000 | 400 | 4 000 000 | ~133 / km² |
| 10 m | 10 000 | 100 | 1 000 000 | ~33 / km² |
| 15 m | 4 444 | 44 | 444 400 | ~15 / km² |
| 20 m | 2 500 | 25 | 250 000 | ~8 / km² |
| 30 m | 1 111 | 11 | 111 100 | ~4 / km² |
| 50 m | 400 | 4 | 40 000 | ~1 / km² |
| 75 m | 178 | 2 | 17 800 | <1 / km² |
| 100 m | 100 | 1 | 10 000 | <1 / km² |
| 150 m | 44 | <1 | 4 400 | <1 / km² |
| 200 m | 25 | <1 | 2 500 | <1 / km² |
| 300 m | 11 | <1 | 1 100 | <1 / km² |
| 500 m | 4 | <1 | 400 | <1 / km² |
| 1 000 m | 1 | <1 | 100 | <1 / km² |

`N = A / d²`. Short-range mesh networks have practical per-network node limits, so denser grids require **multiple border routers / "mesh islands"** joined by the backhaul.

### 6.2 Bandwidth & Storage vs. Spacing

| Spacing | Nodes/km² | Aggregate @12 B | Aggregate @40 B | Storage/day/km² @12 B | @40 B |
|---|---|---|---|---|---|
| 5 m | 40 000 | ~480 KB/s (≈3.8 Mbps) | ~1.6 MB/s (≈12.8 Mbps) | ~41 GB | ~138 GB |
| 10 m | 10 000 | ~120 KB/s (≈1 Mbps) | ~400 KB/s (≈3.2 Mbps) | ~10 GB | ~35 GB |
| 15 m | 4 444 | ~53 KB/s (≈427 kbps) | ~178 KB/s (≈1.4 Mbps) | ~4.6 GB | ~15 GB |
| 20 m | 2 500 | ~30 KB/s (≈0.24 Mbps) | ~100 KB/s (≈0.8 Mbps) | ~2.6 GB | ~8.6 GB |
| 30 m | 1 111 | ~13 KB/s (≈107 kbps) | ~44 KB/s (≈356 kbps) | ~1.2 GB | ~3.8 GB |
| 50 m | 400 | ~4.8 KB/s (≈38 kbps) | ~16 KB/s (≈128 kbps) | ~0.4 GB | ~1.4 GB |
| 75 m | 178 | ~2.1 KB/s (≈17 kbps) | ~7.1 KB/s (≈57 kbps) | ~0.18 GB | ~0.6 GB |
| 100 m | 100 | ~1.2 KB/s (≈10 kbps) | ~4 KB/s (≈32 kbps) | ~0.1 GB | ~0.35 GB |
| 150 m | 44 | ~0.53 KB/s (≈4.3 kbps) | ~1.8 KB/s (≈14 kbps) | ~0.05 GB | ~0.15 GB |
| 200 m | 25 | ~300 B/s (≈2.4 kbps) | ~1 KB/s (≈8 kbps) | ~0.03 GB | ~0.09 GB |
| 300 m | 11 | ~133 B/s (≈1.1 kbps) | ~444 B/s (≈3.6 kbps) | ~0.01 GB | ~0.04 GB |
| 500 m | 4 | ~48 B/s (≈0.4 kbps) | ~160 B/s (≈1.3 kbps) | ~0.004 GB | ~0.014 GB |
| 1 000 m | 1 | ~12 B/s (≈0.1 kbps) | ~40 B/s (≈0.3 kbps) | ~0.001 GB | ~0.004 GB |

Per node: ~1 MB/day (12 B) to ~3.5 MB/day (40 B). **Multi-hop concentration** matters: nodes nearer the border router forward their own traffic *plus* their descendants', so the link closest to the BR carries a large multiple of the per-node rate. Batching (e.g. 60 samples/frame) trims framing overhead and radio wakeups.

### 6.3 Protocol Recommendation

| Regime | Spacing | Aggregate load | Recommended protocol |
|---|---|---|---|
| Very dense | ≤ ~10 m | ~1–13 Mbps/km² | Thread/802.15.4 or BLE Mesh, but load may exceed mesh capacity — **aggregate on relays** or use a higher-capacity radio; many border routers. |
| Dense | ~10–30 m | ~0.1–3 Mbps/km² | **Thread / 802.15.4 (6LoWPAN + RPL)** — short links, low power, IPv6-native; multiple border routers (default). |
| Medium | ~30–100 m | ~10–360 kbps/km² | Thread/802.15.4, or Wi-Fi mesh (802.11s) when mains-powered. |
| Wide | ~100–300 m | ~1–32 kbps/km² | LoRa mesh / LPWAN-friendly; battery nodes feasible. |
| Sparse | ≥ ~300 m | < ~4 kbps/km² | LoRa mesh / LPWAN; per-hop range dictates a mesh of long-range links. |

**Default recommendation: Thread / 802.15.4 mesh**, partitioned across multiple border routers — it fits the low-power, short-link, multi-hop profile and is IPv6-native for OTA and management. Choose BLE Mesh only when the hardware is BLE-constrained, and LoRa mesh only when coverage needs range beyond a hop at low density.

The node radio should be **integrated in the ≤ €7 MCU** — ESP32-S3/C3 (Wi-Fi + BLE) or nRF52840 (BLE + 802.15.4 / Thread). Boards without a radio (e.g. RP2040, STM32F103) need an add-on radio, which breaks the budget.

## 7. Key Data Entities

| Entity | Key Attributes | Notes |
|--------|----------------|-------|
| `Sensor` | `id`, `zone_id`, `location`, `role`, `firmware_version`, `status` | Edge node; runs models; drives an LED; may relay. |
| `Zone` | `id`, `name`, `profile` | Grouping used for contextual baselines. |
| `NoiseSample` | `sensor_id`, `zone_id`, `timestamp`, `amplitude`, `unit`, `time_slot` | 1 Hz amplitude reading; the raw noise history. |
| `NoiseAggregate` | `sensor_id`/`zone_id`, `interval` (min/hour), `avg`, `min`, `max`, `timestamp` | Rolled-up history for long-term storage. |
| `EdgeEvent` | `event_id`, `sensor_id`, `zone_id`, `type`, `class`, `confidence`, `level`, `timestamp`, `model_version` | Semantic event emitted by a node; no raw audio. |
| `MeshLink` | `node_a`, `node_b`, `rssi`, `quality`, `last_seen` | Observed mesh connectivity/topology. |
| `Incident` | `id`, `zone_id`, `severity`, `started_at`, `duration`, `state`, `source_location` | Fused, possibly multi-node view. |
| `Notification` | `id`, `recipient_id`, `type`, `tier`, `sent_at`, `status` | Business alert or authority escalation. |
| `Recipient` | `id`, `type`, `contact`, `zone_id` | Business, authority, or patrol. |
| `ModelArtifact` | `id`, `kind`, `version`, `checksum`, `target_hw` | Deployed via the Model & Config Registry (OTA). |

## 8. Primary Flows

### 8.1 Noise History Flow (1 Hz telemetry)

1. Node measures amplitude each second → **Amplitude Sampler** emits a `NoiseSample`.
2. **Telemetry Emitter** batches samples → **Mesh Stack** (low priority) → **Border Router**.
3. **Telemetry Gateway** validates → **Time-Series Store** persists the noise history.
4. **Noise Analytics** builds per-zone/time-slot baselines, trends, and reports.
5. Roll-up jobs downsample raw 1 s data into minute/hour aggregates per the retention policy.

### 8.2 Noise Governance Flow (edge-first, over the mesh)

0. **Zone baseline learning** — the **Anomaly Detector** learns the zone's *normal* from local audio (normal-only, unsupervised): quick calibration at install, then continuous adaptation to time slot and drift. See model spec §4.1.
1. Node captures audio → **Feature Extractor** → **Anomaly Detector** scores it locally against the learned zone baseline.
2. **Edge Decision Logic** applies hysteresis; **Local Signal Controller** updates the LED in real time (no network).
3. On threshold breach, **Event Emitter** hands an `EdgeEvent` to the **Mesh Stack**, which routes it hop-by-hop (priority over telemetry) toward the **Border Router**.
4. **Event Fusion** correlates events; **Escalation Engine** evaluates persistence/tier.
5. **Notification Router** sends a preventive alert to nearby businesses.
6. If the anomaly persists beyond the configured window despite warnings, the tier rises and authorities are notified.

### 8.3 Urban Safety Flow (edge-first, over the mesh)

1. **Critical-Sound Classifier** detects a critical sound on-node → **Local Signal Controller** may signal locally → `EdgeEvent` emitted.
2. The event may **flood the mesh neighborhood** (low-latency, redundant paths) so nearby nodes corroborate quickly.
3. **Triangulation** fuses time-synchronized events from multiple nodes → estimated source location.
4. **Dispatch Coordinator** alerts the nearest patrol, reducing response time.
5. Optional privacy-gated evidence clip accompanies a confirmed critical event.

## 9. Edge Deployment & Lifecycle

- **OTA model updates** — signed artifacts from the Model & Config Registry, distributed across the mesh; staged/rollback-capable.
- **Versioning** — every `EdgeEvent` and `NoiseSample` carries `model_version`/`firmware_version` for traceability.
- **Drift & recalibration** — per-zone baselines adapt over time; monitor for concept drift in ambient profiles.
- **Fleet observability** — node health, mesh topology, routing quality, telemetry completeness, and inference latency reported upstream.

## 10. Cross-Cutting Concerns

- **Latency** — local signaling is immediate; events are prioritized over telemetry; only fusion, escalation, and dispatch depend on the backhaul.
- **Bandwidth** — 1 Hz telemetry is small per node but scales linearly with node count; batching and roll-up keep the mesh and storage bounded.
- **Power** — steady 1 Hz transmission plus relay duty is the dominant battery cost; batching reduces radio wakeups.
- **Privacy** — nodes transmit amplitude values and semantic events, not raw audio; raw capture stays on-device unless a critical event is confirmed.
- **Time & synchronization** — samples and triangulation need a mesh-wide synchronized clock; localization accuracy is tied to clock alignment (sub-meter accuracy needs sub-millisecond alignment at typical baselines).
- **Mesh security** — wireless multi-hop demands link encryption, node authentication, and key rotation; rogue nodes must not join.
- **Escalation proportionality** — actions are tiered and data-driven, now backed by recorded noise history.
- **Resilience** — redundant mesh paths; nodes buffer telemetry during partitions and backfill when reconnected.
- **Observability** — each tier transition and dispatch is logged with the triggering evidence.

## 11. Open Questions

- **Node spacing `d` and covered area `A`** — the primary inputs to the scale model (§6); everything downstream depends on them. Grid vs. street-linear layout too.
- **Mesh protocol choice** — the scale model (§6.3) points to Thread/802.15.4 as the default; confirm once `d` and `A` are set.
- **Mesh partitioning** — border routers / mesh islands needed at the chosen density, and how zones map onto them.
- Node count and cost — driven by `d` and `A` (see §6.1).
- Retention & roll-up thresholds for the noise history (raw window, aggregate intervals, archive duration).
- Fixed 1 Hz everywhere, or adaptive sampling (denser on anomaly, sparser when quiet)?
- Time-sync mechanism and the target accuracy for triangulation (sub-meter ⇒ sub-ms alignment).
- Node power strategy: battery vs. mains, and the relay duty-cycle trade-off.
- Node hardware: **≤ €7 MCU** (ESP32-S3/C3 or nRF52840) — confirm the ML-throughput vs. radio/mesh vs. power trade-off (see model spec §2).
- **"Normal" learning**: which unsupervised method (rolling stats vs. kNN feature bank vs. tiny autoencoder) per hardware tier, and the calibration window (§4.1 of the model spec).
- **Absolute/legal reference vs. learned novelty** — how to prevent a learned baseline from masking a persistently noisy venue.
- Raw-audio retention policy and privacy constraints for evidence clips.
- SLA/latency targets for the safety path (on-node detection → patrol dispatch).
- Integration boundary with existing authority dispatch systems.
