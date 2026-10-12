# 🏙️ NoiStop / Torino Noise Monitor — Urban Acoustic Sensor Network

[![Next.js](https://img.shields.io/badge/Next.js-16.4-black?logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19.3-blue?logo=react)](https://react.dev/)
[![SQLite](https://img.shields.io/badge/SQLite-WAL%20Mode-003B57?logo=sqlite)](https://www.sqlite.org/)
[![TinyML](https://img.shields.io/badge/Edge%20AI-DS--CNN%20INT8-orange)](#-edge-ai--machine-learning)
[![Hardware Cost](https://img.shields.io/badge/Production%20BOM-%E2%89%A4%2010%20%E2%82%AC-green)](#-analisi-hardware-e-bill-of-materials-bom)
[![License](https://img.shields.io/badge/License-MIT-lightgrey.svg)](LICENSE)

> **Un'unica infrastruttura di sensori acustici intelligenti per due obiettivi fondamentali: città più vivibili attraverso la gestione preventiva del rumore urbano (movida) e strade più sicure mediante il rilevamento tempestivo di eventi critici.**

---

## 📋 Indice dei Contenuti
- [1. Il Problema](#1-il-problema)
- [2. La Soluzione](#2-la-soluzione)
- [3. Come Funziona il Sistema](#3-come-funziona-il-sistema)
- [4. Architettura Tecnica del Sistema](#4-architettura-tecnica-del-sistema)
- [5. Edge AI & Machine Learning](#5-edge-ai--machine-learning)
- [6. Politiche di Sicurezza & Hardening](#6-politiche-di-sicurezza--hardening)
- [7. Analisi Hardware e Bill of Materials (BOM)](#7-analisi-hardware-e-bill-of-materials-bom)
- [8. Interfaccia Bot Telegram (@NoiseTurin_bot)](#8-interfaccia-bot-telegram-noiseturin_bot)
- [9. Portale Amministrativo & Gestione Utenze](#9-portale-amministrativo--gestione-utenze)
- [10. API Reference](#10-api-reference)
- [11. Guida all'Installazione e Avvio Rapido](#11-guida-allinstallazione-e-avvio-rapido)

---

## 1. Il Problema

### Il Conflitto della Movida Urbana
Nelle aree a forte densità di locali e vita notturna (es. i quartieri di San Salvario, Vanchiglia e Centro a Torino), l'inquinamento acustico rappresenta una delle cause primarie di attrito tra:
- **Attività commerciali (esercenti):** Rischiano pesanti sanzioni economiche, sospensioni di licenza o sequestri a seguito di controlli a campione o esposti formali.
- **Residenti:** Subiscono un degrado costante della qualità del riposo e della salute psicofisica dovuto a volumi eccessivi che si protraggono per ore.
- **Pubblica Amministrazione e Polizia Locale:** Devono gestire continue segnalazioni, spesso prive di riscontri oggettivi o tardive, con risorse limitate per pattugliare l'intero territorio.

### Il Vuoto Preventivo e la Mancanza di Dati Oggettivi
I metodi tradizionali sono esclusivamente **punitivi ed ex-post**: un fonometro viene posizionato sporadicamente, oppure una pattuglia interviene quando il conflitto è già esasperato. L'esercente non ha alcuno strumento per rendersi conto che la folla all'esterno del proprio locale ha superato i limiti consentiti prima dell'arrivo delle forze dell'ordine.

### La Sicurezza delle Strade Notturne
Parallelamente, le strade cittadine nelle ore tarde necessitano di presidi attivi per la pubblica incolumità. Eventi critici improvvisi — quali **grida di aiuto (*screams*)**, **spari (*gunshots*)**, **incidenti o impatti violenti (*impact crashes*)** e **sirene** — rischiano di non essere segnalati tempestivamente, ritardando l'intervento dei soccorsi e delle forze di polizia.

### Il Vincolo Etico e Legale della Privacy (GDPR)
L'installazione di microfoni nello spazio pubblico è storicamente ostacolata dal rischio di sorveglianza di massa. Trasmettere o memorizzare stream audio continui violerebbe apertamente il Regolamento Generale sulla Protezione dei Dati (GDPR) e la privacy dei cittadini.

---

## 2. La Soluzione

**NoiStop / Torino Noise Monitor** affronta entrambe le sfide integrando un'unica rete di sensori acustici intelligenti (*Edge AI Acoustic Nodes*):

```
┌────────────────────────────────────────────────────────────────────────┐
│                        INFRASTRUTTURA UNICA                             │
├───────────────────────────────────┬────────────────────────────────────┤
│      1. GOVERNANCE DEL RUMORE     │       2. SICUREZZA URBANA          │
├───────────────────────────────────┼────────────────────────────────────┤
│ • Monitoraggio continuo dB(A)     │ • Riconoscimento suoni critici     │
│ • Segnalazione visiva (LED)       │   (grida di soccorso, spari)       │
│ • Allerta preventiva all'esercente│ • Triangolazione acustica TDoA     │
│ • Escalation basata su persistenza│ • Notifica istantanea alle Forze   │
│   (> 10 min continui sopra soglia)│   dell'Ordine (Zero-Radius Limit)  │
└───────────────────────────────────┴────────────────────────────────────┘
```

### I Punti Cardine del Modello:
1. **Privacy-by-Design Assoluta:** L'elaborazione audio avviene **interamente on-edge** (a bordo del microcontrollore/SoC). Nessun flusso audio grezzo viene mai registrato su disco né trasmesso in rete. Dal nodo escono unicamente campionamenti scalari sintetici (1 dB al secondo) e tag semantici tipizzati (es. `scream`, confidenza 92%).
2. **Autodisciplina Visiva sul Posto:** Un indicatore luminoso a LED (Verde / Giallo / Rosso) e un display OLED posizionati all'esterno del locale comunicano in tempo reale lo stato acustico a clienti e passanti, inducendo un comportamento responsabile spontaneo.
3. **Approccio Proattivo vs Punitivo:** Quando la soglia critica (≥ 70 dB) viene violata in modo continuativo, il sistema invia prima una notifica Telegram all'esercente limitrofo per consentirgli di rientrare nei limiti ed evitare multe.
4. **Escalation Oggettiva alle Autorità:** Solo se la violazione persiste nel tempo o in caso di evento di emergenza conclamato (urla/spari), scatta la segnalazione automatica alle forze dell'ordine con geolocalizzazione esatta.

---

## 3. Come Funziona il Sistema

### Flusso 1: Rilevamento Livello Acustico e Telemetria (1 Hz)
```
[Microfono MEMS]
       │ (16 kHz PCM)
       ▼
[Edge Node: RMS & dBFS] ──▶ Conversione dB SPL (Calibrazione +100 dB)
       │
       ├──▶ [LED Tricolore Locale] (Verde: <66 dB | Giallo: 66-80 dB | Rosso: ≥81 dB)
       │
       └──▶ [Coda Circolare RAM] ──(HTTP POST Keep-Alive)──▶ [Server Master Next.js]
                                                                     │
                                                       ┌─────────────┴─────────────┐
                                                       ▼                           ▼
                                            [Database SQLite WAL]        [EventBus SSE 0ms]
                                                       │                           │
                                                       ▼                           ▼
                                            [Valutazione Persistenza]    [Dashboard Mappa Web]
```

### Flusso 2: Motore di Persistenza e Escalation Esercenti
1. **Rilevamento:** Se la lettura supera la soglia (`sound_intensity >= 70 dB`).
2. **Validazione Temporale:** Vengono accettati solo dati freschi (età `< 120 secondi`), prevenendo falsi allarmi su dati storici all'avvio.
3. **Calcolo della Persistenza:**
   - La violazione deve protrarsi ininterrottamente per almeno **10 minuti**.
   - **Grace Period (Tolleranza):** Brevi pause sotto soglia (es. 1-2 minuti) non azzerano il timer, evitando l'elusione del controllo con fluttuazioni casuali.
4. **Verifica Orario Locale:** Tramite integrazione OpenStreetMap (Overpass API) o Google Places API, il sistema controlla se l'attività commerciale limitrofa risulta aperta. Se il locale è chiuso, l'allerta viene silenziata per non recare disturbo.
5. **Cooldown Anti-Spam:** Tra un avviso e il successivo allo stesso esercente intercorre un intervallo minimo di **10 minuti**.
6. **Escalation Istituzionale:** Se dopo l'allerta preventiva la situazione di anomalia persiste, l'evento viene archiviato come infrazione conclamata per i report della Polizia Locale.

### Flusso 3: Riconoscimento Suoni di Pericolo (Safety Path)
```
[Finestra Audio 1s @ 16kHz]
            │
            ▼
[Log-Mel Spectrogram 40×49] ──▶ [TinyML DS-CNN Model]
                                          │
                  ┌───────────────────────┴───────────────────────┐
                  ▼                                               ▼
       [Evento Ordinario / Rumore]                   [Evento Pericolo Rilevato]
       (traffico, voci, musica, cani)               (scream, gunshot, crash, siren)
                  │                                               │
                  ▼                                               ▼
          Telemetria di routine                   Confidenza > 80% (> 0.80)?
                                                     │              │
                                                  NO │          SÌ  │
                                                     ▼              ▼
                                                Scartato    [1. Trigger Bridge MCU]
                                                (anti-FP)   Display OLED: "SCREAM 93%"
                                                            LED Rosso fisso
                                                                    │
                                                            [2. POST /api/alerts/safety]
                                                                    │
                                                     ┌──────────────┴──────────────┐
                                                     ▼                             ▼
                                           [Esercenti in Raggio]          [Forze dell'Ordine]
                                           (Default: 150m)                (Tutta la Città)
```

---

## 4. Architettura Tecnica del Sistema

Il sistema adotta un'architettura **stratificata, modulare e resiliente**:

```
┌────────────────────────────────────────────────────────────────────────┐
│                          LIVELLO 1: EDGE NODES                         │
│   • Microfono MEMS I2S / USB                                           │
│   • Front-end DSP (DC-Blocker, High-pass 100 Hz, Log-Mel 40×49)         │
│   • Modello TinyML DS-CNN INT8 (Classificazione & Novelty Baseline)    │
│   • Logica deterministica su MCU (LED RGB + OLED SSD1306)              │
│   • Coda circolare in RAM (Zero-Data-Loss buffer per cadute di rete)   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP Keep-Alive / Mesh Radio
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     LIVELLO 2: MASTER INGESTION & CORE                 │
│   • Next.js 16 (App Router, Node.js Runtime)                           │
│   • Schema Validation Rigorosa con Zod                                 │
│   • Rate Limiting Anti-DoS a finestra scorrevole                       │
│   • SQLite Database con Driver ad alte prestazioni better-sqlite3      │
│     (Pragma WAL Mode + Synchronous NORMAL per scritture ad alta freq)  │
│   • Event Bus in-memory (`EventEmitter`) collegato a SSE               │
└──────────────────┬─────────────────────────────────┬───────────────────┘
                   │                                 │
                   ▼                                 ▼
┌──────────────────────────────────────┐  ┌──────────────────────────────┐
│       LIVELLO 3: FRONTEND WEB        │  │     LIVELLO 4: NOTIFICHE     │
│ • Dashboard Real-Time (Next.js/React)│  │ • Telegram Bot Daemon        │
│ • Mappa Vettoriale Leaflet/MapLibre  │  │   (@NoiseTurin_bot)          │
│ • Server-Sent Events (SSE) a 0ms     │  │ • Haversine Distance Calc    │
│ • Portale Admin RBAC con Scrypt Auth │  │ • Geocodifica Nominatim OSM  │
│ • Zonizzazione Acustica di Torino    │  │ • Check Orari Apertura (OSM) │
└──────────────────────────────────────┘  └──────────────────────────────┘
```

---

## 5. Edge AI & Machine Learning

Il modello di classificazione acustica rispetta le specifiche di progettazione per microcontrollori a bassissimo costo:

### Specifiche del Modello
- **Architettura Trunk:** **DS-CNN (Depthwise-Separable Convolutional Neural Network)**, riferimento dello standard MLPerf Tiny KWS e modelli ESC-50.
- **Formato di Deployment:** Quantizzazione totale **INT8** con footprint `< 100 KB` di memoria RAM/Flash (compatibile con i 512 KB SRAM di un ESP32-S3 senza ricorrere alla PSRAM lenta).
- **Input Pipeline:** Finestra scorrevole di 1 secondo a 16 kHz mono. Spettrogramma log-mel a 40 filtri mel × 49 intervalli temporali.
- **Condizionamento del Segnale:**
  - *DC Offset Blocker & Filtro High-Pass (100 Hz):* Rimuove rumble a bassa frequenza e rumore del vento prima della trasformata log-mel, prevenendo falsi positivi su rumori di traffico.
  - *Background Noise Gate:* Soglia a minimo mobile (+8 dB sopra il noise floor) per impedire classificazioni spurie nel silenzio.

### Tassonomia delle Classi
1. **Sicurezza Urbana (Danger Classes - Head B):**
   - `scream`: Urla umane o richieste di aiuto.
   - `gunshot`: Esplosioni da arma da fuoco o petardi pesanti.
   - `siren`: Sirene di emergenza (ambulanze, vigili del fuoco, polizia).
   - `impact_crash`: Incidenti stradali, vetri infranti, urti violenti.
2. **Rumore Urbano (Urban Classes - Head A):**
   - `human_voice` / `shouting`: Voci umane, schiamazzi, cori.
   - `music`: Musica amplificata da locali o impianti esterni.
   - `engine` / `traffic`: Traffico veicolare, motori, accelerazioni.
   - `machinery_impact`: Lavori in corso, cantieri.
   - `dog`: Latrati di cani.
   - `ambient_quiet` / `silence`: Rumore di fondo o silenzio ordinario.

### Anomaly Baseline (Novità Acustica Unsupervised)
Per adattarsi alle caratteristiche uniche di ogni via senza riaddestrare la rete neurale, il nodo calcola le **statistiche mobili (RollingStats)** sui vettori di embedding 64-D estratti dalla rete, stimando la deviazione della zona rispetto alla sua "normalità" statistica oraria.

---

## 6. Politiche di Sicurezza & Hardening

Il sistema implementa standard di sicurezza enterprise ispirati alle linee guida **OWASP** e alle normative **GDPR**:

| Ambito | Misura Implementata | Dettaglio Tecnico |
|---|---|---|
| **Privacy Dati (GDPR)** | Edge-Only Processing | L'audio grezzo viene scartato immediatamente dalla RAM. Nessun dato vocale o campionamento continuo lascia il sensore. |
| **Autenticazione Sensori** | Multi-Factor Sensor Key | Header HTTP `x-api-key`, header `Authorization: Bearer` o parametro cifrato nel body JSON validati tramite segreto crittografico. |
| **Protezione Anti-DoS** | Sliding Window Rate Limiting | Rate limiter in-memory: max 25 req / 5s per IP/sensore su `/api/telemetry/reading`; max 30 req / min su `/api/alerts/safety`. |
| **Autenticazione Admin** | Password Hashing Scrypt | Hash crittografico NIST-standard con salt casuale crittografico a 16 byte e confronto a tempo costante (`crypto.timingSafeEqual`) contro attacchi side-channel. |
| **Sessioni Web** | HMAC-SHA256 Token | Token di sessione firmati crittograficamente con scadenza temporale fissa (8 ore) e invalidazione immediata al logout. |
| **Controllo Accessi (RBAC)** | Ruoli Superadmin & Operatore | Il Superadmin gestisce le utenze. Gli Operatori possono generare chiavi e visualizzare dati, ma non possono modificare o revocare altre utenze amministrative. |
| **Chiavi Telegram Monouso** | Token `TN-XXXX-XXXX-XXXX` | Generate dall'amministratore con sede pre-validata. Ogni chiave è riscattabile una sola volta; la revoca da dashboard disconnette all'istante la chat Telegram associata. |
| **Validazione Input** | Validazione Rigorosa Zod | Tutti i payload JSON in ingresso sono validati da schemi Zod rigidi (tipi unsigned, regex restrittive su ID, coordinate vincolate al bacino di Torino). |
| **Header HTTP Sicuri** | Hardening OWASP | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection: 1; mode=block`, `Referrer-Policy: strict-origin-when-cross-origin`. |
| **Freschezza Temporale** | Anti-Replay Timestamp Filter | Eventi con timestamp superiore a 120 secondi (2 minuti) rispetto all'orologio del server vengono scartati per evitare notifiche su dati storici al riavvio. |

---

## 7. Analisi Hardware e Bill of Materials (BOM)

### 7.1 Hardware Utilizzato nello Sviluppo (Prototipazione & Validazione)

Durante lo sviluppo e il test funzionale del progetto è stato impiegato il seguente setup:

1. **Scheda Edge: Arduino UNO Q (4GB RAM)**
   - **SoC Primario:** Qualcomm QRB2210 (Quad-Core ARM Cortex-A53 a 2.0 GHz, 4 GB LPDDR4, Debian Linux a 64 bit).
     - *Compito:* Esecuzione dello stack Python, acquisizione ALSA dal microfono (`arecord -D hw:0,2`), estrazione delle feature log-mel e inferenza ONNX Runtime del modello DS-CNN.
   - **Microcontrollore Secondario:** STM32U585 (ARM Cortex-M33 @ 160 MHz con TrustZone).
     - *Compito:* Pilotaggio deterministico dei LED di segnalazione (D2=Verde, D3=Ambra, D4=Rosso) e display I2C OLED SSD1306 (128×64) tramite il protocollo **Arduino RouterBridge RPC**.
2. **Microfoni di Acquisizione:**
   - Microfoni USB / Jack 3.5 mm calibrati su scheda audio ALSA con offset software standard (+100 dB SPL da dBFS).
3. **Server Host Master:**
   - PC workstation per il runtime Next.js 16 e database SQLite locale, esposto tramite tunnel HTTPS (`localtunnel`) per consentire la ricezione dei pacchetti dall'Arduino su reti mobili o hotspot 4G.

---

### 7.2 Hardware per la Realizzazione Industriale Reale (BOM ≤ 10 €)

Per una produzione di massa scalabile sul territorio cittadino (migliaia di nodi installabili sui lampioni della luce pubblica o sulle facciate degli edifici), **non è necessario né sostenibile utilizzare SBC complesse da oltre 50-80 €**. 

È stato progettato un circuito stampato dedicato (**KiCad: `HW/NoiStop`**) che impiega componenti a basso costo con alimentazione integrata dalla rete a 220V AC:

```
┌────────────────────────────────────────────────────────────────────────┐
│             NODO ACUSTICO INDUSTRIALE "NOISTOP" (≤ 10 €)               │
├────────────────────────────────────────────────────────────────────────┤
│  [220V AC Rete/Lampione] ──▶ [Hi-Link HLK-PM01 5V] ──▶ [ESP32-WROOM-32]│
│                                                               ▲        │
│  [Microfono MEMS I2S TDK InvenSense MMICT5848] ───────────────┤        │
│                                                               ▼        │
│  [LED RGB Segnalazione] ◀─────────────────────────── [Mesh Radio / Wi-Fi]
│                                                                        │
│  Enclosure: Scatola Stagna ABS Grado IP65 per Esterni                 │
└────────────────────────────────────────────────────────────────────────┘
```

#### Bill of Materials (BOM) Dettagliato (Stima su 1.000 unità)

| Componente | Modello / Codice Parte | Funzione | Costo Unitario (€) | Spedizione Stimata (€) | Totale Parziale (€) |
|---|---|---|:---:|:---:|:---:|
| **Microcontrollore (MCU)** | Espressif ESP32-WROOM-32E (8MB Flash / 64Mbit) | Elaborazione DSP, Inferenza INT8, Radio Wi-Fi/BLE Mesh | 2.00 € | 0.30 € | **2.30 €** |
| **Microfono Digitale** | TDK InvenSense MMICT5848-00-012 | MEMS digitale I2S, elevato range dinamico, SNR elevato per esterni | 1.40 € | 0.30 € | **1.70 €** |
| **Alimentatore AC-DC** | Hi-Link HLK-PM01 (220V AC ➔ 5V DC 3W) | Connessione diretta alla linea elettrica pubblica dei lampioni | 2.00 € | 0.30 € | **2.30 €** |
| **Circuito Stampato (PCB)** | Custom PCB 2-Layer (KiCad `NoiStop`) | Substrato FR4, finitura HASL, serigrafia e fori di montaggio | 0.30 € | 0.30 € | **0.60 €** |
| **Assemblaggio (PCBA)** | Servizio SMT Pick & Place industriale | Montaggio automatizzato e saldatura componenti superficiali | 0.65 € | Incluso | **0.65 €** |
| **Involucro Esterno** | Scatola plastica ABS Impermeabile IP65 | Protezione da pioggia, sole, polvere e agenti atmosferici | 1.55 € | 0.30 € | **1.85 €** |
| **TOTALE PER UNITÀ** | | | | | **~9.40 € (Max 10.00 €)** |

> **Nota di Scalabilità:** Con un costo unitario inferiore a **10 €**, un'amministrazione comunale o un consorzio di quartiere può coprire un intero rione storico (es. 200 nodi distribuiti ogni 15-20 metri) con un budget hardware inferiore a **2.000 €**.

---

## 8. Interfaccia Bot Telegram (@NoiseTurin_bot)

Il bot Telegram funge da canale bidirezionale per esercenti e autorità:

### Comandi Disponibili
- `/start`: Avvia la conversazione con il bot e richiede l'inserimento della chiave di autorizzazione.
- `/login <CHIAVE>`: Riscatta la **chiave monouso** rilasciata dall'amministrazione (es. `TN-9A4B-7C2E-1D8F`). La sede, le coordinate e il raggio di pertinenza vengono associati all'istante senza che l'esercente debba inserire manualmente indirizzi.
- `/stazioni`: Calcola in tempo reale e mostra tutte le stazioni acustiche attive situate entro il raggio della propria attività, indicando la distanza esatta in metri (calcolata con formula Haversine).
- `/raggio <metri>`: Personalizza il raggio di ascolto attorno alla propria attività (default: `150m`).
- `/stato`: Visualizza il riepilogo del profilo: nome attività, indirizzo certificato, raggio attivo, stato di notifica e data ultimo avviso.
- `/test_allerta`: Esegue una simulazione di allerta per verificare la corretta ricezione dei messaggi.
- `/aiuto`: Mostra la guida sintetica ai comandi.

---

## 9. Portale Amministrativo & Gestione Utenze

Accessibile su `http://localhost:3000/admin`:

1. **Dashboard Monitoraggio Totale:**
   - Mappa in tempo reale con stato delle celle acustiche (valori dB, storico ultime 24 ore, allarmi attivi).
   - Elenco esercenti registrati con geolocalizzazione e conteggio allerte ricevute.
2. **Generatore Chiavi Telegram con Sede Certificata:**
   - L'amministratore seleziona il nome del locale e digita la via con numero civico a Torino (es. `Via Santa Giulia 14, Torino`).
   - Il sistema geocodifica le coordinate tramite OpenStreetMap Nominatim e genera la chiave monouso `TN-XXXX-XXXX-XXXX`.
   - L'esercente deve solo digitare `/login <CHIAVE>` su Telegram: zero errori di digitazione o ambiguità di posizione.
3. **Revoca Istantanea:**
   - Possibilità di disattivare qualsiasi chiave con un click: la sessione Telegram collegata viene revocata all'istante.
4. **Controllo Accessi RBAC (Gestione Utenti):**
   - Schermata `/admin/users` per la creazione di nuovi operatori comunali e revoca credenziali.
   - Istituzione di gerarchia rigida: gli operatori non possono creare altri operatori né revocare il Superadmin.

---

## 10. API Reference

### 10.1 Ingestion Telemetria Acustica
- **Endpoint:** `POST /api/telemetry/reading`
- **Autenticazione:** Header `x-api-key: <SENSOR_API_KEY>`
- **Payload Esempio:**
```json
{
  "station_id": "ard-uno-q-real",
  "sound_intensity": 74,
  "timestamp": 1773332000000
}
```
- **Risposta (201 Created):**
```json
{
  "success": true,
  "data": { "id": 1042, "station_id": "ard-uno-q-real", "sound_intensity": 74, "timestamp": 1773332000000 },
  "alert_triggered": true,
  "telegram_subscribers_notified": 2
}
```

### 10.2 Allerta di Sicurezza & Emergenza (Safety Alert)
- **Endpoint:** `POST /api/alerts/safety`
- **Autenticazione:** Header `x-api-key: <SENSOR_API_KEY>`
- **Payload Esempio:**
```json
{
  "station_id": "ard-uno-q-real",
  "event_type": "scream",
  "confidence": 0.93,
  "timestamp": 1773332000000,
  "message": "Urla di soccorso rilevate in prossimità della cella"
}
```
- **Comportamento:**
  - Se `confidence <= 0.80`: L'allerta viene ignorata (prevenzione falsi positivi).
  - Se `confidence > 0.80`: Dispatch immediato via Telegram a tutti gli esercenti nel raggio e a tutti i canali delle **Forze dell'Ordine** configurati in `AUTHORITY_TELEGRAM_CHAT_IDS`.

### 10.3 Streaming Real-Time (Server-Sent Events)
- **Endpoint:** `GET /api/telemetry/stream?filter=all`
- **Header Risposta:** `Content-Type: text/event-stream`
- **Eventi Emessi:**
  - `init`: Snapshot completo di tutte le stazioni all'istante di connessione (0ms).
  - `reading`: Aggiornamento push a ogni nuovo pacchetto inviato da un sensore.
  - `: ping`: Heartbeat ogni 15 secondi per mantenere aperto il socket.

---

## 11. Guida all'Installazione e Avvio Rapido

### Prerequisiti
- Node.js ≥ 20.x e npm
- Python ≥ 3.10
- Git

### 1. Clonazione e Configurazione Ambiente
```bash
git clone https://github.com/tuo-username/noise-heatmap-torino.git
cd noise-heatmap-torino

# Installa le dipendenze JavaScript
npm install

# Configura le variabili d'ambiente
cp .env.example .env.local
```

Modifica `.env.local` impostando i tuoi valori (token Telegram, coordinate e chiavi API):
```env
TELEGRAM_BOT_TOKEN="il-tuo-bot-token"
SENSOR_API_KEY="arduino-torino-noise-secret-2026"
INITIAL_SUPERADMIN_PASSWORD="TuaPasswordSicura2026!"
```

### 2. Avvio dei Servizi Locali
```bash
# Terminale 1: Server Master Full-Stack Next.js (Dashboard + API + SSE)
npm run dev

# Terminale 2: Bot Telegram Daemon
npm run bot

# Terminale 3: Simulatore stazioni di Torino (per test senza hardware)
npm run simulate
```

### 3. Avvio Stazione Hardware su Arduino UNO Q
Sulla scheda Arduino Uno Q (ambiente Linux connesso alla stessa rete Wi-Fi del PC):
```bash
# Installa le dipendenze Python
pip3 install requests

# Avvia la telemetria verso il Server Master
python3 scripts/arduino_uno_q_telemetry.py --server http://192.168.22.103:3000/api/telemetry/reading
```

Per l'esecuzione tramite **Arduino App Framework** con Edge AI completa e coprocessore STM32:
```bash
cd SoundObserver
python3 python/main.py
```

### 4. Esposizione Pubblica su Internet (Accesso Remoto da Hotspot 4G)
```bash
npm run tunnel
# Genera un URL pubblico HTTPS (es. https://torino-noise.loca.lt)
```

---

## 📄 Licenza
Questo progetto è distribuito sotto licenza MIT. Consulta il file `LICENSE` per ulteriori dettagli.