import {
  getCompanyBySlug,
  getCompaniesByChatId,
  linkTelegramChat,
  unlinkTelegramChat,
} from '@/lib/db';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

function getBotToken(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN;
}

export interface TelegramSendResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

/**
 * Invia un messaggio di testo tramite la Bot API di Telegram.
 * Se il token non è configurato l'invio viene saltato (nessuna eccezione),
 * così gli ambienti di sviluppo restano funzionanti senza credenziali.
 */
export async function sendTelegramMessage(chatId: string, text: string): Promise<TelegramSendResult> {
  const token = getBotToken();
  if (!token) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN non configurato: invio messaggio saltato');
    return { ok: false, skipped: true };
  }

  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      console.error('[telegram] Invio fallito:', data.description || response.statusText);
      return { ok: false, error: data.description || response.statusText };
    }
    return { ok: true };
  } catch (error: any) {
    console.error('[telegram] Errore di rete durante l\'invio:', error.message);
    return { ok: false, error: error.message };
  }
}

export async function getTelegramMe(): Promise<any> {
  const token = getBotToken();
  if (!token) return null;
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/getMe`);
  return response.json().catch(() => null);
}

export async function setTelegramWebhook(url: string, secretToken?: string): Promise<any> {
  const token = getBotToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN non configurato');
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      secret_token: secretToken || undefined,
      allowed_updates: ['message'],
    }),
  });
  return response.json().catch(() => null);
}

export async function deleteTelegramWebhook(): Promise<any> {
  const token = getBotToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN non configurato');
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/deleteWebhook`);
  return response.json().catch(() => null);
}

/**
 * Gestisce un update della Bot API: collega/sgancia la chat dell'esercente
 * al profilo aziendale tramite `/start <slug>`, `/stop` e `/status`.
 */
export async function handleTelegramUpdate(update: any): Promise<void> {
  const message = update?.message;
  const text: string | undefined = message?.text;
  const chatId: number | string | undefined = message?.chat?.id;

  if (!chatId || !text) return;

  const chatIdStr = String(chatId);
  const [rawCommand, ...args] = text.trim().split(/\s+/);
  const command = rawCommand.toLowerCase().split('@')[0];

  if (command === '/start') {
    const slug = args[0];
    if (!slug) {
      await sendTelegramMessage(
        chatIdStr,
        'Benvenuto su Noise Monitor Torino.\n\n' +
          'Per collegare questo account Telegram al tuo esercizio, invia:\n' +
          '/start <slug-esercizio>\n\n' +
          'Lo slug ti è stato fornito in fase di registrazione dell\'attività.'
      );
      return;
    }

    const company = linkTelegramChat(slug, chatIdStr);
    if (!company) {
      await sendTelegramMessage(
        chatIdStr,
        `Nessun esercizio trovato con slug "${slug}". Verifica il codice e riprova.`
      );
      return;
    }

    await sendTelegramMessage(
      chatIdStr,
      `Collegamento completato. Riceverai qui le allerte acustiche per:\n` +
        `• ${company.name} (${company.slug})\n\n` +
        `Quando il rumore resta elevato per oltre 10 minuti ti chiederemo di intervenire. ` +
        `Invia /status per la verifica o /stop per disattivare le notifiche.`
    );
    return;
  }

  if (command === '/stop') {
    const removed = unlinkTelegramChat(chatIdStr);
    await sendTelegramMessage(
      chatIdStr,
      removed > 0
        ? 'Notifiche disattivate. Non riceverai più allerte acustiche. Invia /start <slug> per riattivarle.'
        : 'Questa chat non era collegata ad alcun esercizio.'
    );
    return;
  }

  if (command === '/status') {
    const companies = getCompaniesByChatId(chatIdStr);
    if (companies.length === 0) {
      await sendTelegramMessage(chatIdStr, 'Nessun esercizio collegato. Invia /start <slug> per iniziare.');
      return;
    }
    const lines = companies.map((c) => `• ${c.name} (${c.slug})`).join('\n');
    await sendTelegramMessage(chatIdStr, `Esercizi collegati a questa chat:\n${lines}`);
    return;
  }

  if (command === '/help') {
    await sendTelegramMessage(
      chatIdStr,
      'Comandi disponibili:\n' +
        '/start <slug> — collega un esercizio\n' +
        '/status — mostra gli esercizi collegati\n' +
        '/stop — disattiva le notifiche'
    );
  }
}
