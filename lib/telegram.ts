import { TELEGRAM_BOT_TOKEN } from './constants';
import { calculateHaversineDistanceMeters } from './geo';
import {
  getCompanyBySlug,
  getCompaniesByChatId,
  linkTelegramChat,
  unlinkTelegramChat,
  getActiveAuthenticatedSubscribers,
  updateSubscriberLastAlert,
  TelegramSubscriber,
} from '@/lib/db';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

function getBotToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN;
}

export interface TelegramSendResult {
  ok: boolean;
  success: boolean;
  skipped?: boolean;
  error?: string;
}

/**
 * Invia un messaggio tramite la Bot API di Telegram.
 * Supporta parseMode ('HTML' o 'Markdown').
 */
export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  parseMode: 'Markdown' | 'HTML' = 'HTML'
): Promise<TelegramSendResult> {
  const token = getBotToken();
  if (!token) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN non configurato: invio messaggio saltato');
    return { ok: false, success: false, skipped: true, error: 'Token non configurato' };
  }

  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      console.error('[telegram] Invio fallito:', data.description || response.statusText);
      return { ok: false, success: false, error: data.description || response.statusText };
    }
    return { ok: true, success: true };
  } catch (error: any) {
    console.error('[telegram] Errore di rete durante l\'invio:', error.message);
    return { ok: false, success: false, error: error.message };
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

/**
 * Formatta il messaggio di allerta rumore per Telegram (HTML sicuro).
 */
export function formatNoiseAlertMessage(params: {
  stationName: string;
  stationId: string;
  soundIntensity: number;
  distanceMeters: number;
  userAddress: string;
  userRadiusMeters: number;
  timestamp?: number;
  customMessage?: string;
}): string {
  const timeStr = new Date(params.timestamp || Date.now()).toLocaleTimeString('it-IT');
  const dateStr = new Date(params.timestamp || Date.now()).toLocaleDateString('it-IT');

  return `🚨 <b>ALLERTA RUMORE CRITICO A TORINO</b> 🚨

⚠️ <b>Livello Acustico Rilevato:</b> <code>${params.soundIntensity} dB</code> (SOGLIA DI ALLARME SUPERATA)
📡 <b>Cella Acustica:</b> <b>${params.stationName}</b> [<code>${params.stationId}</code>]
📍 <b>Distanza dalla tua attività:</b> <b>${Math.round(params.distanceMeters)} metri</b> (Entro il tuo raggio di ${params.userRadiusMeters}m)
🏢 <b>Tua Sede:</b> ${params.userAddress}
🕒 <b>Rilevamento:</b> ${dateStr} ore ${timeStr}

${params.customMessage ? `📝 <i>Nota: ${params.customMessage}</i>\n` : ''}
⚡ <i>Allerta generata automaticamente dal sistema di monitoraggio urbano Torino Noise. Si consiglia di verificare le pertinenze o le emissioni dell'area circostante.</i>`;
}

/**
 * Elabora una notifica di rumore e la inoltra a tutti gli iscritti la cui attività
 * si trova entro il raggio parametrizzato (default 150m) dalla stazione in allarme.
 */
export async function dispatchNoiseAlertToSubscribers(params: {
  station: { id: string; name: string; latitude: number; longitude: number };
  soundIntensity: number;
  customMessage?: string;
  cooldownMs?: number; // Prevenzione spam (default: 45 secondi)
}): Promise<{
  notifiedCount: number;
  subscribersEvaluated: number;
  results: Array<{
    chat_id: string;
    address: string;
    distanceMeters: number;
    radiusMeters: number;
    status: 'sent' | 'cooldown' | 'error';
    error?: string;
  }>;
}> {
  const subscribers = getActiveAuthenticatedSubscribers();
  const cooldown = params.cooldownMs ?? 45_000;
  const now = Date.now();

  const results: Array<any> = [];
  let notifiedCount = 0;

  for (const sub of subscribers) {
    if (sub.latitude == null || sub.longitude == null) continue;

    // Calcolo geodetico rigoroso della distanza
    const distanceMeters = calculateHaversineDistanceMeters(
      sub.latitude,
      sub.longitude,
      params.station.latitude,
      params.station.longitude
    );

    const radius = sub.alert_radius_meters || 150;

    // Controlla se la stazione rumorosa rientra nel raggio dell'attività
    if (distanceMeters <= radius) {
      // Verifica anti-spam (cooldown)
      if (sub.last_alert_at && (now - sub.last_alert_at) < cooldown) {
        results.push({
          chat_id: sub.chat_id,
          address: sub.address || '',
          distanceMeters,
          radiusMeters: radius,
          status: 'cooldown',
        });
        continue;
      }

      const text = formatNoiseAlertMessage({
        stationName: params.station.name,
        stationId: params.station.id,
        soundIntensity: params.soundIntensity,
        distanceMeters,
        userAddress: sub.address || 'Indirizzo registrato',
        userRadiusMeters: radius,
        timestamp: now,
        customMessage: params.customMessage,
      });

      const sendRes = await sendTelegramMessage(sub.chat_id, text, 'HTML');

      if (sendRes.ok || sendRes.success) {
        updateSubscriberLastAlert(sub.chat_id, now);
        notifiedCount++;
        results.push({
          chat_id: sub.chat_id,
          address: sub.address || '',
          distanceMeters,
          radiusMeters: radius,
          status: 'sent',
        });
      } else {
        results.push({
          chat_id: sub.chat_id,
          address: sub.address || '',
          distanceMeters,
          radiusMeters: radius,
          status: 'error',
          error: sendRes.error,
        });
      }
    }
  }

  return {
    notifiedCount,
    subscribersEvaluated: subscribers.length,
    results,
  };
}
