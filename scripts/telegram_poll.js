// Long polling per lo sviluppo locale: legge gli update da Telegram e li inoltra
// al webhook locale, così il bot funziona senza URL pubblico.
//
// Prerequisito: nessun webhook registrato (esegui prima: node scripts/telegram_set_webhook.js --delete)
//
// Uso:
//   node scripts/telegram_poll.js
//
// Variabili opzionali:
//   TELEGRAM_LOCAL_WEBHOOK_URL (default: http://localhost:3000/api/telegram/webhook)

const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
}

loadEnv();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN mancante. Definiscilo in .env prima di eseguire lo script.');
  process.exit(1);
}

const base = `https://api.telegram.org/bot${token}`;
const localUrl = process.env.TELEGRAM_LOCAL_WEBHOOK_URL || 'http://localhost:3000/api/telegram/webhook';
const headers = { 'Content-Type': 'application/json' };
if (process.env.TELEGRAM_WEBHOOK_SECRET) {
  headers['x-telegram-bot-api-secret-token'] = process.env.TELEGRAM_WEBHOOK_SECRET;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  console.log(`Long polling attivo → inoltro a ${localUrl}`);
  let offset = 0;
  for (;;) {
    try {
      const res = await fetch(`${base}/getUpdates?timeout=30&offset=${offset}`);
      const data = await res.json();
      if (!data.ok) {
        console.error('getUpdates error:', data.description);
        await sleep(2000);
        continue;
      }
      for (const update of data.result) {
        offset = update.update_id + 1;
        try {
          await fetch(localUrl, { method: 'POST', headers, body: JSON.stringify(update) });
          console.log(`Update ${update.update_id} inoltrato`);
        } catch (err) {
          console.error('Inoltro fallito:', err.message);
        }
      }
    } catch (err) {
      console.error('Polling error:', err.message);
      await sleep(2000);
    }
  }
})();
