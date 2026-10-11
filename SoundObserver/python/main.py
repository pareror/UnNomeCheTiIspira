"""App Lab entry point for the Urban Acoustic Sensor (Arduino UNO Q).

Loop (once per hop, default 1 s):

    16 kHz window -> log-mel (40x49) -> DS-CNN -> {urban class, safety, embedding}
        -> unsupervised novelty baseline -> decision logic -> LED (via Bridge) + telemetry

The audio is analysed locally and only compact semantics leave the node: one
amplitude sample (NoiseSample) per second and typed EdgeEvent lines on
transitions. No raw audio is transmitted (see docs/system-architecture-model.md).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from edge.anomaly import RollingStats
from edge.audio import BackgroundGate, make_source, rms_dbfs
from edge.config import RuntimeConfig, load_config
from edge.decision import LED_OFF, LED_RED, DecisionLogic
from edge.engine import ModelRunner
from edge.features import LogMel
from edge.preprocess import Preprocessor

try:  # Present only inside App Lab; absent when running on a desktop for tests.
    from arduino.app_utils import App, Bridge
except Exception:  # noqa: BLE001 - the app must still run off-board
    App = None
    Bridge = None


class Runtime:
    def __init__(self, cfg: RuntimeConfig) -> None:
        self.cfg = cfg
        model_path = cfg.resolve_model()
        self.runner = ModelRunner.from_dir(model_path)
        self.meta = self.runner.meta
        cfg.win_seconds = self.meta.win_seconds  # honor the model's window length (1 s / 5 s)
        self.logmel = LogMel(
            sample_rate=cfg.sample_rate,
            n_mels=self.meta.n_mels,
            target_frames=self.meta.frames,
        )
        self.preprocess = Preprocessor(cfg.sample_rate, cfg.highpass_hz, cfg.peak_normalize)
        self.baseline = RollingStats(n_features=self.meta.embedding_dim)
        self.decision = DecisionLogic(cfg.decision)
        self.source = make_source(cfg)
        self.gate = (
            BackgroundGate(cfg.silence_dbfs, cfg.background_margin_db)
            if cfg.source == "mic" and cfg.background_margin_db > 0
            else None
        )
        self._last_led = None
        self._prev_flags = {"alarm": False, "safety": False}
        print(
            f"[edge] model={model_path.name} classes={self.meta.n_urban} "
            f"frames={self.meta.frames} win={self.meta.win_seconds}s "
            f"highpass={cfg.highpass_hz:.0f}Hz source={cfg.source} "
            f"bridge={'on' if _bridge_ok(cfg) else 'off'}"
        )

    # -- helpers ---------------------------------------------------------------
    def _set_led(self, state: int) -> None:
        if state == self._last_led:
            return
        self._last_led = state
        if _bridge_ok(self.cfg) and Bridge is not None:
            try:
                Bridge.call("set_led", int(state))
            except Exception as exc:  # noqa: BLE001
                print(f"[edge] bridge set_led failed: {exc}")

    def _event(self, kind: str, payload: dict) -> None:
        line = {"ts": time.time(), "type": kind, **payload, "model_version": self.meta.version}
        print("[event] " + json.dumps(line))

    # -- one hop ---------------------------------------------------------------
    def step(self) -> None:
        t0 = time.time()
        window = self.source.read_window()
        dbfs = rms_dbfs(window)
        idle = self.gate.update(dbfs) if self.gate is not None else dbfs < self.cfg.silence_dbfs

        if idle:
            # Quiet/background: report "silence", drop any latched state, never alert.
            self.decision.reset()
            self._set_led(LED_OFF)
            self._prev_flags = {"alarm": False, "safety": False}
            self._telemetry_silence(window)
            time.sleep(max(0.0, self.cfg.hop_seconds - (time.time() - t0)))
            return

        feat = self.logmel(self.preprocess(window))  # (1, 1, n_mels, frames)
        result = self.runner.infer(feat)
        uncertain = result.urban_confidence < self.cfg.min_confidence

        if self.baseline.count_ < self.cfg.calibration_windows:
            self.baseline.update(result.embedding)  # learn "normal" at install
        novelty = self.baseline.novelty(result.embedding)

        state = self.decision.update(
            anomaly_score=novelty,
            safety_prob=result.safety_prob,
            urban_confidence=result.urban_confidence,
        )
        self._set_led(state["led"])

        for flag in ("safety", "alarm"):
            if state[flag] and not self._prev_flags[flag]:
                if flag == "safety":
                    cls = self.meta.class_names[result.urban_index]
                    self._event("EdgeEvent.safety", {"class": cls, "confidence": result.safety_prob})
                else:
                    self._event("EdgeEvent.noise_anomaly", {"novelty": round(novelty, 4)})
        self._prev_flags = {"alarm": state["alarm"], "safety": state["safety"]}

        self._telemetry(window, result, novelty, state, uncertain)

        elapsed = time.time() - t0
        time.sleep(max(0.0, self.cfg.hop_seconds - elapsed))

    def _telemetry(self, window, result, novelty, state, uncertain: bool) -> None:  # noqa: ANN001
        line = {
            "type": "NoiseSample",
            "ts": round(time.time(), 3),
            "amplitude_dbfs": round(rms_dbfs(window), 2),
            "class": "uncertain" if uncertain else self.meta.class_names[result.urban_index],
            "confidence": round(result.urban_confidence, 3),
            "safety_prob": round(result.safety_prob, 3),
            "novelty": round(novelty, 3),
            "led": state["led"],
            "alarm": state["alarm"],
        }
        print("[telemetry] " + json.dumps(line))

    def _telemetry_silence(self, window) -> None:  # noqa: ANN001
        line = {
            "type": "NoiseSample",
            "ts": round(time.time(), 3),
            "amplitude_dbfs": round(rms_dbfs(window), 2),
            "class": "silence",
            "confidence": 0.0,
            "safety_prob": 0.0,
            "novelty": 0.0,
            "led": LED_OFF,
            "alarm": False,
        }
        print("[telemetry] " + json.dumps(line))


def _bridge_ok(cfg: RuntimeConfig) -> bool:
    return cfg.use_bridge and Bridge is not None


_RUNTIME: Runtime | None = None


def _runtime() -> Runtime:
    global _RUNTIME
    if _RUNTIME is None:
        _RUNTIME = Runtime(load_config())
    return _RUNTIME


def loop() -> None:
    """User loop handed to App.run (called repeatedly by App Lab)."""
    _runtime().step()


def standalone(args: argparse.Namespace) -> None:
    cfg = load_config(
        model_dir=args.model_dir,
        model_file=args.model_file,
        source=args.source,
        wav_path=args.wav,
        use_bridge=False,
    )
    runtime = Runtime(cfg)
    print("[edge] running standalone (Ctrl-C to stop)")
    try:
        while True:
            runtime.step()
    except KeyboardInterrupt:
        print("\n[edge] stopped")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", default=None)
    parser.add_argument("--model-file", default=None)
    parser.add_argument("--source", choices=["wav", "mic"], default="mic")
    parser.add_argument("--wav", default=None)
    return parser.parse_args()


if App is not None:  # inside App Lab
    App.run(user_loop=loop)
elif __name__ == "__main__":  # desktop / manual run
    standalone(_parse_args())
