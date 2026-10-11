"""Live microphone monitor: watch the classifier's output in real time.

Loads the model, opens the microphone (or replays a WAV) and redraws a terminal
panel every hop with the current classification, safety probability, novelty and
LED state.

    # live from the default input device
    python SoundObserver/python/live_monitor.py --model-dir SoundObserver/model

    # pick a device / list them
    python SoundObserver/python/live_monitor.py --list-devices
    python SoundObserver/python/live_monitor.py --device 2

    # without a microphone: replay a clip on a loop
    python SoundObserver/python/live_monitor.py --source wav \
        --wav SoundObserver/test_sounds/traffic.wav

    # line-by-line output (for logs / non-ANSI terminals)
    python SoundObserver/python/live_monitor.py --plain

Requires ``sounddevice`` (``pip install sounddevice``) for microphone capture;
WAV replay needs nothing extra.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from edge.anomaly import RollingStats
from edge.audio import BackgroundGate, make_source, rms_dbfs
from edge.config import DecisionConfig, group_of, load_config
from edge.decision import LED_AMBER, LED_GREEN, LED_OFF, LED_RED, DecisionLogic
from edge.engine import ModelRunner
from edge.features import LogMel
from edge.preprocess import Preprocessor

RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
COLORS = {LED_OFF: "\033[90m", LED_GREEN: "\033[32m", LED_AMBER: "\033[33m", LED_RED: "\033[31m"}
LED_LABEL = {LED_OFF: "OFF", LED_GREEN: "GREEN (nominal)", LED_AMBER: "AMBER (noise)", LED_RED: "RED (safety)"}


def enable_ansi() -> bool:
    """Best-effort ANSI/VT enabling (needed on some Windows consoles)."""
    if os.name == "nt":
        try:
            import ctypes

            kernel32 = ctypes.windll.kernel32
            handle = kernel32.GetStdHandle(-11)
            mode = ctypes.c_uint32()
            if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
                kernel32.SetConsoleMode(handle, mode.value | 0x0004)
        except Exception:  # noqa: BLE001
            return False
    return sys.stdout.isatty()


@dataclass
class Panel:
    meta: object
    top_k: int = 5
    bar_width: int = 28

    def render(self, view: dict) -> str:
        names = self.meta.class_names
        header = [
            f"{BOLD}Urban Acoustic Sensor — live{RESET}  "
            f"{DIM}model v{self.meta.version} · {self.meta.n_urban} classes · "
            f"{self.meta.frames} frames · hop {view['hop']:.2f}s{RESET}",
            "",
        ]
        if view["silent"]:
            lines = header + [
                f"  LED  {COLORS[LED_OFF]}{BOLD}OFF — silence{RESET}",
                f"  {DIM}quiet / background — no alert{RESET}",
                self._metrics_line(view),
                "",
                f"{BOLD}  classification{RESET}  {DIM}silence{RESET}",
            ]
            return "\033[H" + "\n".join(lines + ["", f"{DIM}  Ctrl-C to stop{RESET}"]) + "\033[J"

        order = sorted(range(len(view["probs"])), key=lambda i: view["probs"][i], reverse=True)[: self.top_k]
        color = COLORS[view["led"]]
        cls_note = (
            f"{COLORS[LED_AMBER]}{BOLD}uncertain{RESET} {DIM}(max {view['probs'][order[0]]:.0%}){RESET}"
            if view.get("uncertain")
            else f"{DIM}({group_of(names[order[0]])}){RESET}"
        )
        lines = header + [
            f"  LED  {color}{BOLD}{LED_LABEL[view['led']]}{RESET}",
            f"  safety  {BOLD}{view['safety_prob']:.3f}{RESET}"
            f"{'   ' + BOLD + COLORS[LED_RED] + '⚠ SAFETY EVENT' + RESET if view['safety'] else ''}"
            f"      novelty {view['novelty']:.2f}   alarm "
            f"{'ON' if view['alarm'] else 'off'}",
            self._metrics_line(view),
            "",
            f"{BOLD}  classification{RESET}  {cls_note}",
        ]
        for i in order:
            filled = int(round(view["probs"][i] * self.bar_width))
            bar = "█" * filled + "·" * (self.bar_width - filled)
            mark = "►" if i == view["top"] else " "
            lines.append(f"  {mark} {names[i]:<14} {view['probs'][i]:6.1%}  {DIM}{bar}{RESET}")
        lines += ["", f"{DIM}  Ctrl-C to stop{RESET}"]
        return "\033[H" + "\n".join(lines) + "\033[J"

    @staticmethod
    def _metrics_line(view: dict) -> str:
        return f"  {DIM}amplitude {view['dbfs']:+.1f} dBFS · inference {view['latency_ms']:.1f} ms{RESET}"

    def render_plain(self, view: dict) -> str:
        if view["silent"]:
            return (
                f"{'silence':<14}   -      {view['dbfs']:+.1f}dBFS "
                f"{view['latency_ms']:4.1f}ms  (quiet/background, no alert)"
            )
        names = self.meta.class_names
        top = view["top"]
        label = "uncertain" if view.get("uncertain") else names[top]
        flags = []
        if view["safety"]:
            flags.append("SAFETY")
        if view["alarm"]:
            flags.append("ALARM")
        return (
            f"{label:<14} {view['probs'][top]:5.1%}  "
            f"safety={view['safety_prob']:.2f} novelty={view['novelty']:.2f} "
            f"led={LED_LABEL[view['led']].split()[0]} {view['dbfs']:+.1f}dBFS "
            f"{view['latency_ms']:4.1f}ms {' '.join(flags)}"
        )


def list_devices() -> None:
    import sounddevice as sd

    print(sd.query_devices())


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):  # UTF-8 bar glyphs on any console
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model-dir", default=None)
    parser.add_argument("--model-file", default=None)
    parser.add_argument("--source", choices=["mic", "wav"], default="mic")
    parser.add_argument("--wav", default=None, help="WAV path when --source wav")
    parser.add_argument("--device", default=None, help="input device index or name (mic)")
    parser.add_argument("--list-devices", action="store_true")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--hop", type=float, default=None, help="seconds between updates (default: model window)")
    parser.add_argument("--highpass", type=float, default=None, help="low-cut Hz before log-mel (0 disables; default 100)")
    parser.add_argument("--silence-dbfs", type=float, default=None, help="below this level report 'silence' and never alert (default -50)")
    parser.add_argument("--bg-margin", type=float, default=None, help="mic: dB above the noise floor to accept a window (default 8; 0 disables)")
    parser.add_argument("--min-confidence", type=float, default=None, help="below this the class is reported as 'uncertain' (default 0.6)")
    parser.add_argument("--calibration", type=int, default=10, help="windows used to learn 'normal'")
    parser.add_argument("--safety-threshold", type=float, default=None)
    parser.add_argument("--anomaly-on", type=float, default=None)
    parser.add_argument("--anomaly-off", type=float, default=None)
    parser.add_argument("--plain", action="store_true", help="line-by-line output instead of a redrawn panel")
    args = parser.parse_args()

    if args.list_devices:
        list_devices()
        return

    cfg = load_config(model_dir=args.model_dir, model_file=args.model_file, source=args.source, wav_path=args.wav)
    if args.device is not None:
        cfg.device = int(args.device) if str(args.device).isdigit() else args.device

    model_path = cfg.resolve_model()
    runner = ModelRunner.from_dir(model_path)
    meta = runner.meta
    cfg.win_seconds = meta.win_seconds
    if args.hop is not None:
        cfg.hop_seconds = args.hop

    if args.safety_threshold is not None:
        cfg.decision.safety_threshold = args.safety_threshold
    if args.anomaly_on is not None:
        cfg.decision.anomaly_on = args.anomaly_on
    if args.anomaly_off is not None:
        cfg.decision.anomaly_off = args.anomaly_off
    if args.highpass is not None:
        cfg.highpass_hz = args.highpass
    if args.silence_dbfs is not None:
        cfg.silence_dbfs = args.silence_dbfs
    if args.bg_margin is not None:
        cfg.background_margin_db = args.bg_margin
    if args.min_confidence is not None:
        cfg.min_confidence = args.min_confidence

    logmel = LogMel(sample_rate=cfg.sample_rate, n_mels=meta.n_mels, target_frames=meta.frames)
    preprocess = Preprocessor(cfg.sample_rate, cfg.highpass_hz, cfg.peak_normalize)
    gate = (
        BackgroundGate(cfg.silence_dbfs, cfg.background_margin_db)
        if cfg.source == "mic" and cfg.background_margin_db > 0
        else None
    )
    baseline = RollingStats(n_features=meta.embedding_dim)
    decision = DecisionLogic(cfg.decision)

    try:
        source = make_source(cfg)
    except ImportError:
        raise SystemExit("microphone capture needs 'sounddevice' (pip install sounddevice); "
                         "or use --source wav --wav <clip.wav>")

    interactive = not args.plain and enable_ansi()
    panel = Panel(meta=meta, top_k=args.top_k)

    print(f"[live] model={model_path.name} classes={meta.n_urban} source={cfg.source} "
          f"hop={cfg.hop_seconds:.2f}s highpass={cfg.highpass_hz:.0f}Hz "
          f"UI={'panel' if interactive else 'plain'}", flush=True)
    time.sleep(0.2)

    try:
        while True:
            loop_start = time.perf_counter()
            window = source.read_window()
            dbfs = rms_dbfs(window)
            idle = gate.update(dbfs) if gate is not None else dbfs < cfg.silence_dbfs

            if idle:
                # Quiet/background: report "silence", reset the latch, never alert.
                decision.reset()
                view = {
                    "silent": True, "probs": None, "top": -1,
                    "safety_prob": 0.0, "safety": False, "alarm": False,
                    "led": LED_OFF, "novelty": 0.0, "dbfs": dbfs,
                    "latency_ms": 0.0, "hop": cfg.hop_seconds,
                    "silence_dbfs": cfg.silence_dbfs,
                }
            else:
                t_inf = time.perf_counter()
                result = runner.infer(logmel(preprocess(window)))
                latency_ms = (time.perf_counter() - t_inf) * 1000.0

                if baseline.count_ < args.calibration:
                    baseline.update(result.embedding)
                novelty = baseline.novelty(result.embedding)
                state = decision.update(novelty, result.safety_prob, result.urban_confidence)
                uncertain = result.urban_confidence < cfg.min_confidence

                view = {
                    "silent": False,
                    "uncertain": uncertain,
                    "reported": "uncertain" if uncertain else meta.class_names[result.urban_index],
                    "probs": result.urban_probs,
                    "top": result.urban_index,
                    "safety_prob": result.safety_prob,
                    "safety": state["safety"],
                    "alarm": state["alarm"],
                    "led": state["led"],
                    "novelty": novelty,
                    "dbfs": dbfs,
                    "latency_ms": latency_ms,
                    "hop": cfg.hop_seconds,
                    "silence_dbfs": cfg.silence_dbfs,
                }

            if interactive:
                sys.stdout.write(panel.render(view))
            else:
                sys.stdout.write(panel.render_plain(view) + "\n")
            sys.stdout.flush()

            if not getattr(source, "paces_itself", False):
                time.sleep(max(0.0, cfg.hop_seconds - (time.perf_counter() - loop_start)))
    except KeyboardInterrupt:
        print("\n[live] stopped")
    finally:
        close = getattr(source, "close", None)
        if callable(close):
            close()


if __name__ == "__main__":
    main()
