#!/usr/bin/env python3
"""
===============================================================================
 SIMULATORE ARDUINO UNO Q (4GB RAM) - STAZIONE ACUSTICA REALE CON MICROFONO PC
===============================================================================
- Acquisisce il segnale audio REALE in streaming dal microfono del PC.
- Calcola l'intensità sonora in decibel (dB SPL) ad ogni secondo.
- Rileva automaticamente le coordinate geografiche reali dell'utente (Torino).
- Invia i dati tramite HTTP POST verso il server Master Next.js.
- Sistema avanzato di log da terminale con VU-meter a colori e statistiche di rete.
===============================================================================
"""

import os
import sys
import time
import math
import argparse
import threading
from typing import Dict, Any, Optional

# Risoluzione encoding UTF-8 per console Windows (previene UnicodeEncodeError)
if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# Colori ANSI per terminale
RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
CYAN = "\033[36m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
MAGENTA = "\033[35m"
WHITE = "\033[37m"
BG_BLUE = "\033[44m"
BG_RED = "\033[41m"

try:
    import requests
except ImportError:
    print(f"{RED}[ERRORE]{RESET} Modulo 'requests' mancante. Installa con: pip install requests")
    sys.exit(1)

# Tentativo di importazione librerie audio reali
HAVE_AUDIO = False
try:
    import numpy as np
    import sounddevice as sd
    HAVE_AUDIO = True
except ImportError:
    pass

# CONFIGURAZIONE PREDEFINITA
DEFAULT_SERVER = "http://localhost:3000/api/telemetry/reading"
DEFAULT_API_KEY = "arduino-torino-noise-secret-2026"
DEFAULT_STATION_ID = "ard-uno-q-real-mic"
DEFAULT_STATION_NAME = "Arduino Uno Q (Microfono Reale PC - Torino)"

# Coordinate fallback su Torino Centro se offline
DEFAULT_TURIN_LAT = 45.0705
DEFAULT_TURIN_LON = 7.6868

def get_real_geolocation() -> Dict[str, Any]:
    """Rileva le coordinate geografiche reali dell'utente tramite IP Geolocation."""
    print(f"{CYAN}[GEO]{RESET} Rilevamento coordinate geografiche reali via IP...")
    services = [
        "http://ip-api.com/json",
        "https://ipapi.co/json/",
    ]
    for url in services:
        try:
            r = requests.get(url, timeout=3.0)
            if r.status_code == 200:
                data = r.json()
                lat = data.get("lat") or data.get("latitude")
                lon = data.get("lon") or data.get("longitude")
                city = data.get("city", "Torino")
                region = data.get("regionName") or data.get("region", "Piemonte")
                country = data.get("country", "Italia")
                
                if lat is not None and lon is not None:
                    print(f"{GREEN}[GEO OK]{RESET} Posizione rilevata: {BOLD}{city}{RESET} ({region}, {country}) -> Lat: {lat:.5f}, Lon: {lon:.5f}")
                    return {
                        "lat": float(lat),
                        "lon": float(lon),
                        "city": city,
                        "region": region,
                    }
        except Exception:
            continue

    print(f"{YELLOW}[GEO WARN]{RESET} Impossibile contattare servizi Geo IP. Utilizzo coordinate centrali di Torino.")
    return {
        "lat": DEFAULT_TURIN_LAT,
        "lon": DEFAULT_TURIN_LON,
        "city": "Torino (Centro)",
        "region": "Piemonte",
    }

def get_color_for_db(db: int) -> tuple[str, str]:
    """Restituisce il colore ANSI e l'etichetta testuale per il livello di rumore."""
    if db < 40:
        return WHITE, "ASSENTE / BASSO (Bianco)"
    elif db <= 65:
        return GREEN, "LIEVE (Verde)"
    elif db <= 80:
        return YELLOW, "MEDIO (Giallo)"
    elif db <= 95:
        return RED, "FORTE / ALLARME (Rosso)"
    else:
        return MAGENTA, "INTENSO / CRITICO (Viola)"

def draw_vu_meter(db: int, max_bars: int = 20) -> str:
    """Disegna una barra VU-Meter grafica da terminale compatibile con qualsiasi console Windows."""
    clamped = max(30, min(115, db))
    ratio = (clamped - 30) / (115 - 30)
    filled_bars = int(round(ratio * max_bars))
    empty_bars = max_bars - filled_bars
    
    color, _ = get_color_for_db(db)
    bar_str = "#" * filled_bars + "-" * empty_bars
    return f"{color}[{bar_str}]{RESET}"

class RealAudioSensor:
    """Gestisce il campionamento microfonico reale ad alta fedeltà dal PC."""
    def __init__(self, samplerate: int = 44100):
        self.samplerate = samplerate
        self.is_active = False
        self.device_name = "Nessun dispositivo"

        if HAVE_AUDIO:
            try:
                device_info = sd.query_devices(kind='input')
                self.device_name = device_info.get('name', 'Microfono di default')
                self.is_active = True
                print(f"{GREEN}[AUDIO OK]{RESET} Microfono attivo: {BOLD}{self.device_name}{RESET} (Sample Rate: {self.samplerate} Hz)")
            except Exception as e:
                print(f"{YELLOW}[AUDIO WARN]{RESET} Errore apertura microfono: {e}. Fallback su simulatore acustico.")
                self.is_active = False
        else:
            print(f"{YELLOW}[AUDIO WARN]{RESET} Librerie 'sounddevice' o 'numpy' non disponibili. Uso simulatore.")

    def record_one_second_rms(self) -> float:
        """Campiona esattamente 1 secondo dal microfono e calcola l'RMS reale."""
        if not self.is_active:
            # Fallback sintetico
            return 0.005 + 0.02 * (0.5 + 0.5 * math.sin(time.time() * 0.3))

        try:
            samples = int(self.samplerate * 1.0)
            # Acquisizione bloccante per 1 secondo
            audio_data = sd.rec(samples, samplerate=self.samplerate, channels=1, dtype='float32')
            sd.wait()
            # Calcolo RMS reale: radice quadrata della media dei quadrati
            rms = float(np.sqrt(np.mean(audio_data ** 2)))
            return max(1e-6, rms)
        except Exception as e:
            print(f"\n{YELLOW}[AUDIO ERROR]{RESET} Errore lettura frame audio: {e}")
            return 0.005

    def calculate_db_spl(self, rms: float) -> int:
        """
        Converte il valore RMS in decibel SPL calibrati (30 - 115 dB).
        Formula calibrata per microfoni PC standard con rumore di fondo a ~35 dB.
        """
        # Calibrazione scala logaritmica: 20 * log10(rms) + costante di guadagno
        db_raw = 20.0 * math.log10(rms + 1e-7) + 96.0
        # Normalizzazione in unsigned int realistico
        db_clamped = int(round(max(30.0, min(115.0, db_raw))))
        return db_clamped

def main():
    parser = argparse.ArgumentParser(description="Simulatore Stazione Arduino Uno Q con Microfono PC Reale")
    parser.add_argument("--server", default=DEFAULT_SERVER, help="URL dell'endpoint del server Master")
    parser.add_argument("--key", default=DEFAULT_API_KEY, help="API Key per x-api-key")
    parser.add_argument("--id", default=DEFAULT_STATION_ID, help="ID della stazione slave")
    parser.add_argument("--name", default=DEFAULT_STATION_NAME, help="Nome della stazione")
    parser.add_argument("--lat", type=float, help="Override latitudine")
    parser.add_argument("--lon", type=float, help="Override longitudine")
    args = parser.parse_args()

    # Banner di avvio
    print(f"\n{CYAN}{BOLD}========================================================================={RESET}", flush=True)
    print(f"{CYAN}{BOLD}   ARDUINO UNO Q (4GB) - TELEMETRIA NOISE MONITOR IN TEMPO REALE        {RESET}")
    print(f"{CYAN}{BOLD}========================================================================={RESET}")
    print(f"{WHITE} Target Server Master:{RESET} {args.server}")
    print(f"{WHITE} Identificativo Slave:{RESET} {BOLD}{args.id}{RESET}")
    print(f"{WHITE} API Key configurata :{RESET} {args.key[:8]}...{args.key[-4:]}")

    # Rilevamento Coordinate Geografiche
    geo = get_real_geolocation()
    lat = args.lat if args.lat is not None else geo["lat"]
    lon = args.lon if args.lon is not None else geo["lon"]
    station_name = f"{args.name} [{geo['city']}]"

    print(f"{WHITE} Posizione Mappata   :{RESET} {BOLD}{lat:.5f} N, {lon:.5f} E{RESET} ({geo['city']})")
    print(f"{WHITE} Raggio d'Azione     :{RESET} {BOLD}15 metri (Costante di sistema){RESET}")
    print(f"{CYAN}-------------------------------------------------------------------------{RESET}")

    # Inizializzazione Microfono Reale
    sensor = RealAudioSensor()
    print(f"{CYAN}-------------------------------------------------------------------------{RESET}")
    print(f"{GREEN}{BOLD}[SISTEMA AVVIATO]{RESET} Campionamento audio attivo ogni 1 secondo...")
    print(f"{DIM}Fai rumore, parla o batti le mani per testare l'aumento dei decibel in diretta!{RESET}")
    print(f"{DIM}Premi Ctrl+C per terminare e visualizzare il riepilogo della sessione.{RESET}\n")

    # Sessione HTTP con Keep-Alive (ottimizzazione Arduino Uno Q)
    session = requests.Session()
    session.headers.update({
        "Content-Type": "application/json",
        "x-api-key": args.key,
        "User-Agent": "Arduino-Uno-Q-Real-Mic/1.0",
        "Connection": "keep-alive",
    })

    # Statistiche di sessione
    packet_count = 0
    success_count = 0
    fail_count = 0
    db_history = []
    start_time = time.time()

    try:
        while True:
            cycle_start = time.time()
            packet_count += 1

            # 1. Acquisizione Reale da Microfono (1 secondo)
            rms = sensor.record_one_second_rms()
            db_value = sensor.calculate_db_spl(rms)
            db_history.append(db_value)
            timestamp_ms = int(time.time() * 1000)

            color, label = get_color_for_db(db_value)
            vu_bar = draw_vu_meter(db_value)

            # 2. Costruzione Payload JSON per il Master Next.js
            payload = {
                "station_id": args.id,
                "name": station_name,
                "latitude": lat,
                "longitude": lon,
                "sound_intensity": db_value,  # unsigned int
                "timestamp": timestamp_ms,
                "api_key": args.key,
            }

            # 3. Invio HTTP POST e misura tempi di risposta
            req_time_start = time.time()
            try:
                response = session.post(args.server, json=payload, timeout=2.0)
                latency_ms = (time.time() - req_time_start) * 1000

                if response.status_code == 201:
                    success_count += 1
                    res_json = response.json()
                    row_id = res_json.get("data", {}).get("id", "?")
                    status_badge = f"{GREEN}{BOLD}[OK 201]{RESET}"
                    server_info = f"DB Row #{row_id} | Lat: {latency_ms:.1f}ms"
                else:
                    fail_count += 1
                    status_badge = f"{RED}{BOLD}[HTTP {response.status_code}]{RESET}"
                    server_info = f"Err: {response.text[:35]}"
            except Exception as net_err:
                fail_count += 1
                latency_ms = (time.time() - req_time_start) * 1000
                status_badge = f"{RED}{BOLD}[NET ERR]{RESET}"
                server_info = f"{str(net_err)[:35]}"

            # 4. Log a terminale formattato e dettagliato
            current_clock = time.strftime("%H:%M:%S")
            print(
                f"[{current_clock}] {BOLD}#{packet_count:<4}{RESET} "
                f"{vu_bar} {color}{BOLD}{db_value:>3} dB{RESET} ({color}{label:<22}{RESET}) "
                f"| {status_badge} ({server_info})",
                flush=True
            )

    except KeyboardInterrupt:
        elapsed_total = time.time() - start_time
        print(f"\n\n{CYAN}{BOLD}========================================================================={RESET}")
        print(f"{CYAN}{BOLD}                  RIEPILOGO SESSIONE STAZIONE ARDUINO                    {RESET}")
        print(f"{CYAN}{BOLD}========================================================================={RESET}")
        print(f" Tempo Totale di Monitoraggio : {elapsed_total:.1f} secondi")
        print(f" Pacchetti Trasmessi          : {packet_count} (Riusciti: {GREEN}{success_count}{RESET}, Falliti: {RED}{fail_count}{RESET})")
        if db_history:
            avg_db = sum(db_history) / len(db_history)
            max_db = max(db_history)
            min_db = min(db_history)
            max_color, max_label = get_color_for_db(max_db)
            print(f" Rumore Medio Registrato      : {avg_db:.1f} dB")
            print(f" Livello Minimo Registrato    : {min_db} dB")
            print(f" Picco Massimo Registrato     : {max_color}{BOLD}{max_db} dB ({max_label}){RESET}")
        print(f" Stazione Georeferenziata     : {lat:.5f} N, {lon:.5f} E ({geo['city']})")
        print(f"{CYAN}========================================================================={RESET}\n")

if __name__ == '__main__':
    main()
