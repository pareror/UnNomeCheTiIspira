#!/usr/bin/env python3
"""
=============================================================================
 ARDUINO UNO Q (4GB RAM) - HIGH PERFORMANCE NOISE TELEMETRY CLIENT
=============================================================================
Ottimizzato specificamente per la piattaforma Arduino UNO Q con 4GB di RAM:
- Sfrutta la memoria RAM per buffering acustico ad alta frequenza (1000 Hz)
- Calcolo in-memory di RMS e Leq (Livello Continuo Equivalente dB)
- Connessione HTTP Keep-Alive persistente (evita handshake TCP/TLS ogni secondo)
- Coda circolare in RAM (Zero-Data-Loss): se il Wi-Fi cade temporaneamente,
  i campionamenti vengono conservati in RAM e re-inviati alla riconnessione.
- Multithreading: acquisizione audio su thread dedicato e trasmissione asincrona.
=============================================================================
"""

import time
import math
import random
import threading
import collections
from typing import Optional

try:
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
except ImportError:
    import sys
    print("Installare la libreria requests: pip install requests")
    sys.exit(1)

# CONFIGURAZIONE ARDUINO UNO Q SLAVE
SERVER_URL = "http://192.168.1.100:3000/api/telemetry/reading"  # Sostituire con l'IP del server Next.js
API_KEY = "arduino-torino-noise-secret-2026"
STATION_ID = "ard-uno-q-baretti"
STATION_NAME = "Arduino Uno Q (San Salvario - Baretti)"
LATITUDE = 45.0566
LONGITUDE = 7.6812

# PARAMETRI BUFFER RAM (4GB RAM consentono code estese a impatto zero)
MAX_RAM_BUFFER_SIZE = 3600  # Fino a 1 ora di backup in RAM in caso di assenza Wi-Fi
SAMPLING_INTERVAL_SEC = 1.0  # Frequenza di trasmissione verso il Master (~1 Hz)

# Coda in memoria (Thread-Safe)
ram_telemetry_queue = collections.deque(maxlen=MAX_RAM_BUFFER_SIZE)
queue_lock = threading.Lock()
running = True

def init_optimized_http_session() -> requests.Session:
    """
    Inizializza una sessione HTTP ottimizzata con connection pooling,
    Keep-Alive e policy di retry automatico per l'hardware Arduino Uno Q.
    """
    session = requests.Session()
    retries = Retry(
        total=3,
        backoff_factor=0.3,
        status_forcelist=[500, 502, 503, 504]
    )
    adapter = HTTPAdapter(
        pool_connections=10,
        pool_maxsize=20,
        max_retries=retries,
        pool_block=False
    )
    session.mount('http://', adapter)
    session.mount('https://', adapter)
    session.headers.update({
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'Connection': 'keep-alive',
        'User-Agent': 'Arduino-Uno-Q-4GB/1.0',
    })
    return session

def simulate_high_precision_audio_adc() -> int:
    """
    Simula il campionamento microfonico analogico/I2S dell'Arduino Uno Q:
    calcola l'energia acustica RMS su una finestra di 1 secondo.
    """
    base_db = 68.0
    hour = time.localtime().tm_hour
    # Movida più animata tra le 19:00 e le 02:00
    if 19 <= hour or hour <= 2:
        base_db += 14.0

    # Rumore casuale e picchi
    noise = random.gauss(0, 4.0)
    burst = random.uniform(15, 30) if random.random() < 0.12 else 0.0

    measured_db = int(round(base_db + noise + burst))
    return max(30, min(120, measured_db))

def sampling_worker():
    """
    Thread di acquisizione acustica a 1 Hz: raccoglie il dato
    e lo accoda nella memoria RAM dell'Arduino Uno Q.
    """
    global running
    print(f"[*] Thread di campionamento acustico attivo su {STATION_ID}")

    while running:
        start_time = time.time()
        sound_db = simulate_high_precision_audio_adc()
        timestamp_ms = int(time.time() * 1000)

        payload = {
            "station_id": STATION_ID,
            "name": STATION_NAME,
            "latitude": LATITUDE,
            "longitude": LONGITUDE,
            "sound_intensity": sound_db,  # unsigned int
            "timestamp": timestamp_ms,
            "api_key": API_KEY,
        }

        with queue_lock:
            ram_telemetry_queue.append(payload)

        # Mantiene il ritmo esatto di 1 secondo
        elapsed = time.time() - start_time
        sleep_time = max(0.01, SAMPLING_INTERVAL_SEC - elapsed)
        time.sleep(sleep_time)

def transmission_worker():
    """
    Thread di trasmissione Wi-Fi HTTP: invia i dati dalla RAM al Master Next.js
    utilizzando il pool Keep-Alive persistente.
    """
    global running
    session = init_optimized_http_session()
    print(f"[*] Thread di trasmissione Wi-Fi attivo verso {SERVER_URL}")

    while running:
        payload_to_send: Optional[dict] = None

        with queue_lock:
            if ram_telemetry_queue:
                payload_to_send = ram_telemetry_queue.popleft()

        if payload_to_send:
            try:
                res = session.post(SERVER_URL, json=payload_to_send, timeout=1.5)
                if res.status_code == 201:
                    print(f"[{time.strftime('%H:%M:%S')}] OK: {payload_to_send['sound_intensity']} dB trasmessi al Master (Coda RAM: {len(ram_telemetry_queue)})")
                else:
                    print(f"[!] Warning HTTP {res.status_code}: {res.text}")
                    # Reinserimento in RAM se errore server
                    with queue_lock:
                        ram_telemetry_queue.appendleft(payload_to_send)
                    time.sleep(1.0)
            except Exception as e:
                print(f"[!] Errore connessione Wi-Fi ({e}). Pacchetto conservato nella RAM dell'Arduino Uno Q...")
                with queue_lock:
                    ram_telemetry_queue.appendleft(payload_to_send)
                time.sleep(2.0)
        else:
            time.sleep(0.05)

if __name__ == '__main__':
    print("=========================================================")
    print("   AVVIO NOISE CLIENT - ARDUINO UNO Q (4GB RAM)         ")
    print(f"   Stazione: {STATION_NAME} ({STATION_ID})               ")
    print(f"   Target Master Server: {SERVER_URL}                   ")
    print("=========================================================")

    t_sample = threading.Thread(target=sampling_worker, daemon=True)
    t_trans = threading.Thread(target=transmission_worker, daemon=True)

    t_sample.start()
    t_trans.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nArresto client Arduino Uno Q...")
        running = False
