"""App Lab entry point for the Urban Acoustic Sensor (Arduino UNO Q).

Loop (once per hop, default 1 s):

    16 kHz window -> log-mel (40x49) -> DS-CNN -> {urban class, safety, embedding}
        -> unsupervised novelty baseline -> decision logic -> LED (via Bridge) + telemetry

The audio is analysed locally and only compact semantics leave the node: one
amplitude sample (NoiseSample) per second and typed EdgeEvent lines on
transitions. Danger events (scream/gunshot) are also POSTed to the master server,
which forwards them to Telegram; the event string is pushed to the MCU for the
OLED. No raw audio is transmitted (see docs/system-architecture-model.md).
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
from edge.config import SAFETY_CLASSES, RuntimeConfig, load_config
from edge.decision import LED_OFF, LED_RED, DecisionLogic
from edge.engine import ModelRunner
from edge.features import LogMel
from edge.preprocess import Preprocessor
from edge.report import ServerReporter

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
        self.reporter = ServerReporter(cfg) if cfg.report_safety else None
        self._last_led = None
        self._last_display = None
        self._prev_flags = {"alarm": False, "safety": False}
        print(
            f"[edge] model={model_path.name} classes={self.meta.n_urban} "
            f"frames={self.meta.frames} win={self.meta.win_seconds}s "
            f"highpass={cfg.highpass_hz:.0f}Hz source={cfg.source} "
            f"bridge={'on' if _bridge_ok(cfg) else 'off'} "
            f"report={'on' if self.reporter is not None else 'off'}"
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

    def _show(self, text: str) -> None:
        """Push a string to the MCU to render on the OLED (only when it changes)."""
        if text == self._last_display:
            return
        self._last_display = text
        if _bridge_ok(self.cfg) and Bridge is not None:
            try:
                Bridge.call("show_event", text)
            except Exception as exc:  # noqa: BLE001
                print(f"[edge] bridge show_event failed: {exc}")

    def _event(self, kind: str, payload: dict) -> None:
        line = {"ts": time.time(), "type": kind, **payload, "model_version": self.meta.version}
        print("[event] " + json.dumps(line))

    def _raise_safety(self, result) -> None:  # noqa: ANN001
        """Danger detected: log it, notify the server (-> Telegram) and the OLED."""
        cls = self.meta.class_names[result.urban_index]
        self._event("EdgeEvent.safety", {"class": cls, "confidence": result.safety_prob})
        event_type = cls if cls in SAFETY_CLASSES else "other"
        if self.reporter is not None:
            self.reporter.send_safety(event_type, result.safety_prob)
        self._show(f"{cls.upper()} {result.safety_prob:.0%}")

    def close(self) -> None:
        if self.reporter is not None:
            self.reporter.close()

    # -- one hop ---------------------------------------------------------------
    def step(self) -> None:
        t0 = time.time()
        res = http_session.post(SERVER_URL, json=payload, timeout=1.0)
        lat_ms = (time.time() - t0) * 1000
        if res.status_code in (200, 201):
            db = payload['sound_intensity']
            print(f"[{time.strftime('%H:%M:%S')}] \033[32m[OK 201]\033[0m Trasmessi {db:>3} dB al Server Master ({lat_ms:.1f}ms) | Coda RAM: {len(ram_telemetry_queue)}")
            return True
        else:
            print(f"[!] Warning HTTP {res.status_code}: {res.text[:80]}")
            return False
    except Exception as e:
        print(f"[!] Connessione Wi-Fi assente ({e.__class__.__name__}). Pacchetto salvato nella RAM dell'Arduino...")
        return False


def transmission_worker():
    """Thread di trasmissione asincrono: invia i dati dalla RAM al Master."""
    global running
    while running:
        payload_to_send = None
        with queue_lock:
            if ram_telemetry_queue:
                payload_to_send = ram_telemetry_queue.popleft()

        if payload_to_send:
            ok = transmit_packet(payload_to_send)
            if not ok:
                with queue_lock:
                    ram_telemetry_queue.appendleft(payload_to_send)
                time.sleep(2.0)
        else:
            time.sleep(0.05)


# =============================================================================
# 5. LOOP PRINCIPALE DI ACQUISIZIONE ED INVIO
# =============================================================================
def loop():

    #global state
    """Funzione di loop chiamata continuamente dall'Arduino App Framework o dal main."""
    try:
        # 1. Registra audio hardware dal microfono (arecord dura RECORD_DURATION_SEC)
        proc = subprocess.run(ARECORD_CMD, capture_output=True)
        if proc.returncode != 0:
            err_msg = proc.stderr.decode(errors='ignore').strip()
            print(f"[!] Errore arecord ({ARECORD_DEVICE}): {err_msg[:60]}")
            # Fallback temporaneo se il dispositivo hw:0,2 non risponde
            rms_db, peak_db = -45.0, -25.0
        else:
            rms_db, peak_db = get_wav_db(AUDIONAME)

        # 2. Conversione in decibel SPL calibrati
        livello = dbfs_to_scala(rms_db)
        picco = dbfs_to_scala(peak_db)
        db_int = int(round(livello))

        # Stampa su console Arduino
        print(f"[{time.strftime('%H:%M:%S')}] Rilevati: {db_int:>3} dB ({classifica(livello)}) | picco {picco:.1f} dB [RMS {rms_db:.1f} dBFS]")

        # 3. Costruzione payload per il Server Master (solo dati essenziali)
        payload = {
            "station_id": STATION_ID,
            "sound_intensity": db_int,
            "timestamp": int(time.time() * 1000),
            "api_key": API_KEY,
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
    finally:
        runtime.close()


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
