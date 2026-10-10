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
| `/login <chiave>` | Attiva la **chiave monouso** rilasciata dall'amministratore (es: `TN-9A4B-7C2E-1D8F`). La sede e le coordinate vengono associate all'istante! |
| `/stazioni` | Elenca le celle acustiche attive entro il raggio della tua sede con la distanza esatta in metri. |
| `/raggio <metri>` | Modifica il raggio di controllo attorno alla tua attività (default: `150m`). |
| `/stato` | Mostra attività, sede certificata dall'amministrazione, coordinate, raggio, soglia (70 dB) e anti-spam. |
| `/test_allerta` | Invia una notifica di prova per verificare che la chat riceva correttamente. |
| `/aiuto` | Mostra il riepilogo dei comandi all'interno di Telegram. |

---

## 🔐 Portale Amministratori (`/admin`)

- **URL:** `http://localhost:3000/admin` (Login: `admin` / credenziale in `.env.local`).
- **Funzionalità Amministrazione:**
  - **Generazione Chiavi con Sede Certificata:** L'amministratore inserisce il nome del locale e la via con numero civico a Torino (es. `Via Santa Giulia 12, Torino`). L'indirizzo viene geocodificato e salvato all'istante, evitando qualsiasi errore di sintassi da parte dell'utente.
  - **Monouso Rigoroso & Revoca:** Ogni chiave può essere riscattata una sola volta e può essere revocata in tempo reale con disconnessione immediata della chat Telegram collegata.
  - **Gestione Utenze Amministrative (RBAC):** Creazione operatori e revoca utenze (gli operatori non possono revocare altre utenze né il Superadmin).

---

## 🛡️ Regole Chiave del Sistema

1. **Sede Pre-registrata dall'Amministrazione:** l'esercente non deve inserire la via su Telegram; la sede viene registrata e validata dall'admin al rilascio della chiave monouso.
2. **Soglia di Allarme:** le notifiche scattano se il livello sonoro rilevato è **≥ 70 dB**.
3. **Anti-Spam 10 Minuti:** tra un avviso e l'altro per la stessa attività intercorrono almeno **10 minuti**.
4. **Validità Temporale (Max 2 Minuti):** vengono notificati solo eventi accaduti negli ultimi **120 secondi**, evitando falsi allarmi su dati storici o vecchi al riavvio del server.
5. **API Protetta Allerte:** `POST /api/alerts/noise` protetta da header `x-api-key` configurata in `.env.local`.
