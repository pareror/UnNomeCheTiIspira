// Registra / ispeziona / rimuove il webhook del bot Telegram.
//
// Uso:
//   node scripts/telegram_set_webhook.js https://<url-pubblico>   # registra il webhook
//   node scripts/telegram_set_webhook.js --info                    # mostra stato bot e webhook
//   node scripts/telegram_set_webhook.js --delete                  # rimuove il webhook
//
// In locale Telegram non raggiunge localhost: usa un tunnel (es. ngrok) per l'URL pubblico,
// oppure lo script scripts/telegram_poll.js per il long polling in sviluppo.

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

const api = (method) => `https://api.telegram.org/bot${token}/${method}`;
const arg = process.argv[2];

(async () => {
  if (arg === '--delete') {
    const res = await fetch(api('deleteWebhook'));
    console.log('deleteWebhook:', await res.json());
    return;
  }

  if (arg === '--info' || !arg) {
    const me = await (await fetch(api('getMe'))).json();
    const info = await (await fetch(api('getWebhookInfo'))).json();
    console.log('getMe:', me);
    console.log('getWebhookInfo:', info);
    if (!arg) {
      console.log(
        '\nUso: node scripts/telegram_set_webhook.js https://<url-pubblico> | --info | --delete'
      );
    }
    return;
  }

  const base = arg.replace(/\/$/, '');
  const url = `${base}/api/telegram/webhook`;
  const body = { url, allowed_updates: ['message'] };
  if (process.env.TELEGRAM_WEBHOOK_SECRET) {
    body.secret_token = process.env.TELEGRAM_WEBHOOK_SECRET;
  }

  const res = await fetch(api('setWebhook'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.log('setWebhook', url, '→', await res.json());
})();
