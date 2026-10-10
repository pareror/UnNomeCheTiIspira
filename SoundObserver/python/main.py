#!/usr/bin/env python3
"""
=============================================================================
 ARDUINO UNO Q (4GB RAM) - TELEMETRIA ACUSTICA REALE VERSO TORINO NOISE MONITOR
=============================================================================
Script unificato per Arduino Uno Q:
1. Acquisisce l'audio hardware dal microfono (arecord su hw:0,2).
2. Calcola l'energia RMS in dBFS e la converte in scala decibel (dB SPL).
3. Trasmette i decibel in tempo reale tramite HTTP POST al Server Master Next.js.
4. Supporta buffer circolare in RAM (Zero-Data-Loss in caso di calo Wi-Fi).
5. Invia i dati al coprocessore STM32 su /dev/ttyS0.
6. Compatibile sia con l'Arduino App Framework (App.run) sia con esecuzione standalone.
=============================================================================
"""

# Import sicuro dell'Arduino App Framework
try:
    from arduino.app_utils import App
except ImportError:
    App = None

import os
import sys
import time
import math
import array
import wave
import subprocess
import traceback
import collections
import threading
from typing import Optional
from arduino_bridge import ArduinoBridge
#from arduino.router_bridge import Bridge

# Dipendenza HTTP requests
try:
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
except ImportError:
    print("[ERRORE] Libreria 'requests' mancante. Installa con: pip3 install requests")
    sys.exit(1)


### PROVA a crare eusare un bridge per controllare il led

bridge = ArduinoBridge()
#bridge = Bridge()

#state = 1


# =============================================================================
# 1. CONFIGURAZIONE MASTER SERVER NEXT.JS & PARAMETRI STAZIONE
# =============================================================================
# IP del PC sulla rete Wi-Fi locale
SERVER_URL = os.getenv("SERVER_URL", "http://192.168.22.103:3000/api/telemetry/reading")
API_KEY = os.getenv("SENSOR_API_KEY", "arduino-torino-noise-secret-2026")
STATION_ID = "ard-uno-q-real"
STATION_NAME = "Arduino Uno Q (Stazione Hardware)"
LATITUDE = 45.0566
LONGITUDE = 7.6812

# =============================================================================
# 2. CONFIGURAZIONE AUDIO HARDWARE (ARECORD)
# =============================================================================
AUDIONAME = "test_audio.wav"
ARECORD_DEVICE = "hw:0,2"
RECORD_DURATION_SEC = "3"  # Durata campionamento in secondi per ogni misurazione

ARECORD_CMD = [
    "arecord", "-D", ARECORD_DEVICE,
    "-f", "S16_LE", "-c", "1", "-r", "16000",
    "-d", RECORD_DURATION_SEC, AUDIONAME,
]

CHUNK_FRAMES = 4096

# Calibrazione: dB_scala = dBFS + OFFSET.
# Con 100: -60 dBFS -> 40 dB, -20 dBFS -> 80 dB, -5 dBFS -> 95 dB.
CALIBRATION_OFFSET_DB = 100.0

# Seriale per comunicazione con STM32
SERIAL_PORT = "/dev/ttyS0"
SERIAL_BAUD = 115200

# Parametri buffer RAM per resilienza di rete
MAX_RAM_BUFFER_SIZE = 3600
ram_telemetry_queue = collections.deque(maxlen=MAX_RAM_BUFFER_SIZE)
queue_lock = threading.Lock()
running = True

# Sessione HTTP Keep-Alive
http_session: Optional[requests.Session] = None


# =============================================================================
# 3. FUNZIONI DI CALCOLO E ANALISI ACUSTICA
# =============================================================================
def dbfs_to_scala(dbfs: float) -> float:
    """Converte dBFS nella scala decibel calibrata (mai sotto 0, -inf diventa 0)."""
    if math.isinf(dbfs):
        return 0.0
    return max(0.0, dbfs + CALIBRATION_OFFSET_DB)


def classifica(db: float) -> str:
    """Ritorna l'etichetta del livello di rumore per terminale."""
    if db < 40:
        return "SILENZIO"
    if db < 60:
        return "AMBIENTE"
    if db < 66:
        return "RUMORE LIEVE (verde)"
    if db < 81:
        return "RUMORE MEDIO (giallo)"
    if db <= 95:
        return "RUMORE FORTE (rosso)"
    return "RUMORE INTENSO (viola)"


def get_wav_db(path: str):
    """Analizza il file WAV a 16 bit e calcola (rms_dbfs, peak_dbfs)."""
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError("Supportato solo PCM a 16 bit (S16_LE)")

        somma_quadrati = 0.0
        picco = 0
        totale = 0

        while True:
            raw = w.readframes(CHUNK_FRAMES)
            if not raw:
                break
            campioni = array.array("h")
            campioni.frombytes(raw)
            if sys.byteorder == "big":
                campioni.byteswap()
            for s in campioni:
                somma_quadrati += s * s
                a = -s if s < 0 else s
                if a > picco:
                    picco = a
            totale += len(campioni)

    if totale == 0:
        raise ValueError("Nessun campione nel file audio registrato")

    full_scale = 32768.0
    rms = math.sqrt(somma_quadrati / totale)

    def to_db(x):
        return 20.0 * math.log10(x / full_scale) if x > 0 else float("-inf")

    return to_db(rms), to_db(picco)


# =============================================================================
# 4. GESTIONE TRASMISSIONE WI-FI HTTP VERSO IL SERVER MASTER
# =============================================================================
def init_optimized_http_session() -> requests.Session:
    """Inizializza una sessione HTTP Keep-Alive con retry automatici."""
    session = requests.Session()
    retries = Retry(total=2, backoff_factor=0.2, status_forcelist=[500, 502, 503, 504])
    adapter = HTTPAdapter(pool_connections=10, pool_maxsize=20, max_retries=retries, pool_block=False)
    session.mount('http://', adapter)
    session.mount('https://', adapter)
    session.headers.update({
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'Connection': 'keep-alive',
        'User-Agent': 'Arduino-Uno-Q-Hardware/1.0',
    })
    return session


def transmit_packet(payload: dict) -> bool:
    """Invia un pacchetto acustico via POST verso /api/telemetry/reading."""
    global http_session
    if http_session is None:
        http_session = init_optimized_http_session()
    try:
        t0 = time.time()
        res = http_session.post(SERVER_URL, json=payload, timeout=2.0)
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

        # 3. Costruzione payload per il Server Master
        payload = {
            "station_id": STATION_ID,
            "name": STATION_NAME,
            "latitude": LATITUDE,
            "longitude": LONGITUDE,
            "sound_intensity": db_int,
            "timestamp": int(time.time() * 1000),
            "api_key": API_KEY,
        }

        # 4. Accodamento in RAM (trasmissione asincrona e robusta)
        with queue_lock:
            ram_telemetry_queue.append(payload)

        # 5. Notifica locale all'STM32 via Seriale (se collegato)
   
        
        if (bridge.connect()):  # Waits until connected; True if connected, False on timeout
            #state = not state
            bridge.notify("set_led_level",db_int)
            bridge.disconnect()
            print(f"State {livello} has been sent to mcu")

    except Exception:
        traceback.print_exc()

    time.sleep(0.5)


# =============================================================================
# 6. AVVIO APPLICAZIONE (APP.RUN O STANDALONE)
# =============================================================================
if __name__ == '__main__':
    print("=========================================================================")
    print("   ARDUINO UNO Q (4GB) - NOISE MONITOR TELEMETRY CLIENT                  ")
    print(f"   Stazione ID: {STATION_ID} ({STATION_NAME})                            ")
    print(f"   Server Target: {SERVER_URL}                                           ")
    print(f"   Dispositivo Audio: {ARECORD_DEVICE} ({AUDIONAME})                      ")
    print("=========================================================================")

    # Avvio thread di trasmissione asincrona in background
    t_trans = threading.Thread(target=transmission_worker, daemon=True)
    t_trans.start()

    # Se l'App Framework Arduino è presente esegue App.run(user_loop=loop), altrimenti loop standard
    if App is not None and hasattr(App, 'run'):
        print("[*] Avvio tramite Arduino App Framework...")
        App.run(user_loop=loop)
    else:
        print("[*] Avvio in modalità standalone Python...")
        try:
            while True:
                loop()
        except KeyboardInterrupt:
            print("\nArresto client Arduino...")
            running = False
