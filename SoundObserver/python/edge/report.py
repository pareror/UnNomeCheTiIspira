"""Asynchronous reporter that POSTs danger events to the master server.

The master (Next.js) fans the event out to Telegram: subscribers whose venue is
within their alert radius, plus law enforcement (AUTHORITY_TELEGRAM_CHAT_IDS).

Only the standard library is used (``urllib``), so it adds no runtime dependency
on the board, and the network call runs on a background daemon thread so the 1 s
audio loop is never blocked. Failures are logged and never raised into the loop.
"""

from __future__ import annotations

import json
import queue
import threading
import time
import urllib.request


class ServerReporter:
    """Fire-and-forget reporter for safety (scream/gunshot) events."""

    def __init__(self, cfg, maxsize: int = 64, timeout: float = 3.0) -> None:
        self.url = cfg.safety_alert_url
        self.api_key = cfg.api_key
        self.station_id = cfg.station_id
        self.station_name = cfg.station_name
        self.latitude = cfg.latitude
        self.longitude = cfg.longitude
        self.timeout = timeout
        self._q: "queue.Queue[dict]" = queue.Queue(maxsize=maxsize)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._worker, name="server-reporter", daemon=True)
        self._thread.start()

    def send_safety(self, event_type: str, confidence: float, timestamp: float | None = None) -> None:
        """Queue a danger event; returns immediately (dropping the oldest if full)."""
        payload = {
            "station_id": self.station_id,
            "name": self.station_name,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "event_type": event_type,
            "confidence": round(float(confidence), 4),
            "timestamp": int((timestamp if timestamp is not None else time.time()) * 1000),
            "api_key": self.api_key,
        }
        try:
            self._q.put_nowait(payload)
        except queue.Full:
            try:
                self._q.get_nowait()  # drop the oldest, keep the freshest event
                self._q.put_nowait(payload)
            except queue.Empty:
                pass
            print("[report] coda piena: evento piu' vecchio scartato")

    def _worker(self) -> None:
        while not self._stop.is_set():
            try:
                payload = self._q.get(timeout=0.5)
            except queue.Empty:
                continue
            self._post(payload)

    def _post(self, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self.url,
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "x-api-key": self.api_key,
                "User-Agent": "Arduino-Uno-Q-Edge/1.0",
            },
        )
        for attempt in range(3):
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    body = response.read(200).decode("utf-8", "replace")
                    print(f"[report] safety -> HTTP {response.status} {body}")
                    return
            except Exception as exc:  # noqa: BLE001 - never propagate into the audio loop
                if attempt == 2:
                    print(f"[report] invio fallito: {exc.__class__.__name__}: {exc}")
                else:
                    time.sleep(0.5 * (attempt + 1))

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=2)
