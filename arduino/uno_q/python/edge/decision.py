"""Edge decision logic: temporal smoothing, hysteresis, LED state and events.

A direct port of ``acoustic_models.decision`` so the runtime behaves exactly
like the offline pipeline. Novelty (statistical "normal") is kept separate from
compliance (legal "normal"): this logic emits *novelty* and *safety* signals;
the absolute/legal reference is applied upstream.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

from edge.config import DecisionConfig

LED_OFF = 0
LED_GREEN = 1
LED_AMBER = 2
LED_RED = 3


@dataclass
class DecisionLogic:
    """Stateful decision logic with hysteresis and a moving-average smoother."""

    cfg: DecisionConfig = field(default_factory=DecisionConfig)
    alarm: bool = False
    _buf: deque = field(default_factory=deque, repr=False)

    def smooth(self, value: float) -> float:
        self._buf.append(float(value))
        while len(self._buf) > self.cfg.smooth_window:
            self._buf.popleft()
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
