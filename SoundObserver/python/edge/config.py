"""Runtime configuration and the urban-safety class taxonomy.

The class list itself always comes from the model metadata
(``model_meta.json``) so the runtime adapts to whichever head was trained;
only the semantic groupings below are fixed.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# Semantic groups shared by both deployed taxonomies (urban_safety, freesound_safety).
SAFETY_CLASSES = {"scream", "gunshot"}
NORMAL_CLASSES = {"traffic", "speech", "ambient_quiet"}
ANOMALOUS_CLASSES = {"siren", "car_horn", "construction", "impact_crash"}


@dataclass
class DecisionConfig:
    anomaly_on: float = 0.6
    anomaly_off: float = 0.4
    safety_threshold: float = 0.7
    smooth_window: int = 3


@dataclass
class RuntimeConfig:
    """Everything the runtime loop needs; sensible defaults for the UNO Q."""

    model_dir: Path = field(default_factory=lambda: Path(__file__).resolve().parents[2] / "model")
    model_file: str | None = None  # auto-detected (model_int8.onnx | model.onnx | model.tflite)
    source: str = "mic"  # "mic" (default, App Lab / desktop) | "wav"
    wav_path: str | None = None
    device: int | str | None = None  # sounddevice device for "mic"
    sample_rate: int = 16000
    win_seconds: float = 1.0
    hop_seconds: float = 1.0
    calibration_windows: int = 20  # windows skipped into the normal baseline at start-up
    telemetry_every_n: int = 1  # emit one NoiseSample every N windows
    highpass_hz: float = 100.0  # DC/rumble low-cut applied before log-mel (0 disables)
    peak_normalize: bool = False  # optional per-window peak norm (off: rely on feature mean/std)
    silence_dbfs: float = -50.0  # below this level: report "silence" and never alert
    background_margin_db: float = 8.0  # mic: treat windows within this of the noise floor as idle (0 disables)
    min_confidence: float = 0.6  # below this the class is reported as "uncertain"
    use_bridge: bool = True
    decision: DecisionConfig = field(default_factory=DecisionConfig)

    # --- Master server reporting (danger events -> Telegram via the server) ---
    server_url: str = "http://192.168.22.103:3000"  # base URL of the Next.js master
    api_key: str = "arduino-torino-noise-secret-2026"  # SENSOR_API_KEY on the server
    station_id: str = "ard-uno-q-real"
    station_name: str = "Arduino Uno Q (Stazione Hardware)"
    latitude: float = 45.0566
    longitude: float = 7.6812
    report_safety: bool = True  # POST danger events to the master server

    @property
    def win_samples(self) -> int:
        return int(round(self.win_seconds * self.sample_rate))

    @property
    def hop_samples(self) -> int:
        return int(round(self.hop_seconds * self.sample_rate))

    @property
    def safety_alert_url(self) -> str:
        return self.server_url.rstrip("/") + "/api/alerts/safety"

    def resolve_model(self) -> Path:
        """Return the model file to load, honouring the explicit override."""
        if self.model_file:
            candidate = self.model_dir / self.model_file
            if not candidate.exists():
                raise FileNotFoundError(f"model file not found: {candidate}")
            return candidate
        for name in ("model_int8.onnx", "model.onnx", "model.tflite"):
            candidate = self.model_dir / name
            if candidate.exists():
                return candidate
        raise FileNotFoundError(
            f"no model found in {self.model_dir} (run tools/prepare_model.py first)"
        )


def load_config(**overrides) -> RuntimeConfig:
    """Build a :class:`RuntimeConfig`, applying ``EDGE_*`` env vars then overrides."""
    cfg = RuntimeConfig()
    if os.environ.get("EDGE_MODEL_DIR"):
        cfg.model_dir = Path(os.environ["EDGE_MODEL_DIR"])
    if os.environ.get("EDGE_MODEL_FILE"):
        cfg.model_file = os.environ["EDGE_MODEL_FILE"]
    if os.environ.get("EDGE_SOURCE"):
        cfg.source = os.environ["EDGE_SOURCE"]
    if os.environ.get("EDGE_WAV"):
        cfg.wav_path = os.environ["EDGE_WAV"]
    if os.environ.get("EDGE_DEVICE"):
        dev = os.environ["EDGE_DEVICE"].strip()
        cfg.device = int(dev) if dev.isdigit() else dev
    if os.environ.get("EDGE_USE_BRIDGE"):
        cfg.use_bridge = os.environ["EDGE_USE_BRIDGE"].strip().lower() not in ("0", "false", "no")
    if os.environ.get("EDGE_HIGHPASS"):
        cfg.highpass_hz = float(os.environ["EDGE_HIGHPASS"])
    if os.environ.get("EDGE_SILENCE_DBFS"):
        cfg.silence_dbfs = float(os.environ["EDGE_SILENCE_DBFS"])
    if os.environ.get("EDGE_MIN_CONFIDENCE"):
        cfg.min_confidence = float(os.environ["EDGE_MIN_CONFIDENCE"])
    if os.environ.get("EDGE_BG_MARGIN"):
        cfg.background_margin_db = float(os.environ["EDGE_BG_MARGIN"])
    if os.environ.get("EDGE_SERVER_URL"):
        cfg.server_url = os.environ["EDGE_SERVER_URL"]
    if os.environ.get("SENSOR_API_KEY"):
        cfg.api_key = os.environ["SENSOR_API_KEY"]
    if os.environ.get("STATION_ID"):
        cfg.station_id = os.environ["STATION_ID"]
    if os.environ.get("STATION_NAME"):
        cfg.station_name = os.environ["STATION_NAME"]
    if os.environ.get("LATITUDE"):
        cfg.latitude = float(os.environ["LATITUDE"])
    if os.environ.get("LONGITUDE"):
        cfg.longitude = float(os.environ["LONGITUDE"])
    if os.environ.get("EDGE_REPORT_SAFETY"):
        cfg.report_safety = os.environ["EDGE_REPORT_SAFETY"].strip().lower() not in ("0", "false", "no")
    for key, value in overrides.items():
        if value is not None and hasattr(cfg, key):
            setattr(cfg, key, value)
    cfg.model_dir = Path(cfg.model_dir)
    return cfg


def group_of(class_name: str) -> str:
    if class_name in NORMAL_CLASSES:
        return "normal"
    if class_name in ANOMALOUS_CLASSES or class_name in SAFETY_CLASSES:
        return "anomalous"
    return "other"
