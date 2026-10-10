# ⚡ Comandi Rapidi — Torino Noise Monitor

Guida sintetica ai comandi essenziali per l'esecuzione del progetto e l'interazione con il bot Telegram.

---

## 🛠️ Comandi NPM (Terminale)

| Comando | Descrizione Breve |
|---|---|
| `npm run dev` | Avvia il server Next.js full-stack su `http://localhost:3000` (Dashboard + API SSE). |
| `npm run bot` | Avvia il daemon del bot Telegram `@NoiseTurin_bot` in ascolto per i comandi utente. |
| `npm run mic` | Avvia la stazione reale che campiona i dB dal microfono del PC (Arduino Uno Q emulato). |
| `npm run simulate` | Genera campionamenti casuali sulle stazioni acustiche di Torino per test rapidi. |
| `npm run build` | Esegue il build ottimizzato e verifica i tipi TypeScript (`tsc`). |

---

## 🤖 Comandi Telegram (@NoiseTurin_bot)

| Comando / Input | Descrizione Breve |
|---|---|
| `/start` | Avvia l'interazione con il bot e richiede l'autenticazione. |
| `TORINO-ALERT-KEY-2026` | Chiave di autorizzazione univoca per sbloccare il bot (`/login <chiave>`). |
| `Via Po 14` *(o qualsiasi via + civico)* | Geolocalizza la sede della tua attività a Torino tramite OpenStreetMap. |
| `/raggio <metri>` | Modifica il raggio di controllo attorno alla tua attività (default: `150m`). |
| `/stazioni` | Elenca le celle acustiche attive entro il tuo raggio con la distanza esatta in metri. |
| `/stato` | Mostra sede, coordinate, raggio, soglia (70 dB) e timer anti-spam. |
| `/test_allerta` | Invia una notifica di prova per verificare che la chat riceva correttamente. |
| `/aiuto` | Mostra il riepilogo dei comandi all'interno di Telegram. |

---

## 🛡️ Regole Chiave del Sistema

1. **Soglia di Allarme:** le notifiche scattano se il livello sonoro rilevato è **≥ 70 dB**.
2. **Anti-Spam 10 Minuti:** tra un avviso e l'altro per la stessa attività intercorrono almeno **10 minuti**.
3. **Validità Temporale (Max 2 Minuti):** vengono notificati solo eventi accaduti negli ultimi **120 secondi**, evitando falsi allarmi su dati storici o vecchi al riavvio del server.
4. **API Protetta Allerte:** `POST /api/alerts/noise` protetta da header `x-api-key: dev-sensor-secret-key-2026`.
