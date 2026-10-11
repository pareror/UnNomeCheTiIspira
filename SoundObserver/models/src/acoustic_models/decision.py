"""Edge decision logic: temporal smoothing, hysteresis, LED state and events.

Lives on the node *after* the models. Combines the novelty score, the safety
probability and the urban class into a stable LED state and event flags.

Crucially, novelty (statistical "normal") is kept separate from compliance
(legal "normal"): this logic emits *novelty* and *safety* signals, and the
absolute/legal reference is applied upstream.
"""

from __future__ import annotations

from dataclasses import dataclass, field

LED_OFF = 0
LED_GREEN = 1
LED_AMBER = 2
LED_RED = 3


@dataclass
class DecisionConfig:
    anomaly_on: float = 0.6
    anomaly_off: float = 0.4
    safety_threshold: float = 0.7
    smooth_window: int = 3


@dataclass
class DecisionLogic:
    """Stateful decision logic with hysteresis and a moving-average smoother."""

    cfg: DecisionConfig = field(default_factory=DecisionConfig)
    alarm: bool = False
    _buf: list[float] = field(default_factory=list, repr=False)

    def smooth(self, value: float) -> float:
        self._buf.append(float(value))
        self._buf = self._buf[-self.cfg.smooth_window :]
        return sum(self._buf) / len(self._buf)

    def update(
        self,
        anomaly_score: float,
        safety_prob: float,
        urban_confidence: float = 0.0,
    ) -> dict:
        smoothed = self.smooth(anomaly_score)

        if not self.alarm and smoothed >= self.cfg.anomaly_on:
            self.alarm = True
        elif self.alarm and smoothed <= self.cfg.anomaly_off:
            self.alarm = False

        safety = safety_prob >= self.cfg.safety_threshold
        led = LED_RED if safety else (LED_AMBER if self.alarm else LED_GREEN)

        return {
            "alarm": self.alarm,
            "safety": safety,
            "led": led,
            "smoothed_anomaly": smoothed,
            "urban_confidence": float(urban_confidence),
        }
