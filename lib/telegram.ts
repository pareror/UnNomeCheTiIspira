import { TELEGRAM_BOT_TOKEN, NOISE_ALERT_THRESHOLD_DB, SAFETY_ALERT_NOTIFY_COOLDOWN_MS } from './constants';
import { calculateHaversineDistanceMeters, geocodeAddressTurin } from './geo';
import { evaluateOpenStatus, getOpenStatusProvider } from './open-status';
import {
  getCompanyBySlug,
  getCompaniesByChatId,
  linkTelegramChat,
  unlinkTelegramChat,
  getActiveAuthenticatedSubscribers,
  updateSubscriberLastAlert,
  getTelegramSubscriber,
  upsertTelegramSubscriber,
  setSubscriberActive,
  verifyBotAuthKey,
  redeemBotAuthKey,
  getAllStations,
  insertNoiseAlert,
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

⚠️ <b>Livello Acustico Rilevato:</b> <code>${params.soundIntensity} dB</code> (SOGLIA ≥ 70 dB SUPERATA)
📡 <b>Cella Acustica:</b> <b>${params.stationName}</b> [<code>${params.stationId}</code>]
📍 <b>Distanza dalla tua attività:</b> <b>${Math.round(params.distanceMeters)} metri</b> (Entro il tuo raggio di ${params.userRadiusMeters}m)
🏢 <b>Tua Sede:</b> ${params.userAddress}
🕒 <b>Rilevamento:</b> ${dateStr} ore ${timeStr}

${params.customMessage ? `📝 <i>Nota: ${params.customMessage}</i>\n` : ''}
🛡️ <i>Protezione anti-spam attiva: tra un avviso e l'altro per la tua attività intercorrono almeno 10 minuti.</i>
⚡ <i>Allerta generata automaticamente dal sistema di monitoraggio urbano Torino Noise.</i>`;
}

/**
 * Elabora una notifica di rumore e la inoltra a tutti gli iscritti la cui attività
 * si trova entro il raggio parametrizzato dalla stazione in allarme.
 * Include protezione anti-spam con intervallo minimo di 10 minuti.
 *
 * Ogni iscritto viene inoltre filtrato in base al provider di apertura
 * (manual/osm/google/off); se risulta chiuso la notifica viene saltata.
 * L'esito complessivo viene registrato in `noise_alerts`.
 */
export async function dispatchNoiseAlertToSubscribers(params: {
  station: { id: string; name: string; latitude: number; longitude: number };
  soundIntensity: number;
  timestamp?: number; // Timestamp dell'evento sonoro
  maxAgeMs?: number; // Anzianità massima consentita per inviare l'allerta (default: 2 minuti = 120.000 ms)
  customMessage?: string;
  cooldownMs?: number; // Prevenzione spam (default: 10 minuti = 600.000 ms)
  breach?: { startedAt: number; durationMs: number; thresholdDb: number };
}): Promise<{
  notifiedCount: number;
  subscribersEvaluated: number;
  skippedClosed: number;
  isStale?: boolean;
  results: Array<{
    chat_id: string;
    address: string;
    distanceMeters: number;
    radiusMeters: number;
    status: 'sent' | 'cooldown' | 'closed' | 'error';
    cooldownRemainingSec?: number;
    error?: string;
  }>;
}> {
  const now = Date.now();
  const eventTime = params.timestamp || now;
  const maxAge = params.maxAgeMs ?? (2 * 60 * 1000); // Max 2 minuti

  // Controllo di freschezza temporale: l'evento acustico deve essere accaduto nell'arco di 2 minuti.
  // Previene l'invio di messaggi su dati vecchi o storici al riavvio del server.
  if (Math.abs(now - eventTime) > maxAge) {
    console.warn(
      `[Telegram Alert] Notifica annullata: evento sonoro avvenuto ${Math.round((now - eventTime) / 1000)}s fa (limite: ${maxAge / 1000}s).`
    );
    return {
      notifiedCount: 0,
      subscribersEvaluated: 0,
      skippedClosed: 0,
      isStale: true,
      results: [],
    };
  }

  const subscribers = getActiveAuthenticatedSubscribers();
  const cooldown = params.cooldownMs ?? (10 * 60 * 1000); // 10 minuti di intervallo minimo anti-spam

  const results: Array<any> = [];
  let notifiedCount = 0;
  let skippedClosed = 0;

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

    // La stazione rumorosa deve rientrare nel raggio dell'attività
    if (distanceMeters > radius) continue;

    // Verifica anti-spam: almeno 10 minuti dall'ultima allerta inviata a questa sede
    if (sub.last_alert_at && now - sub.last_alert_at < cooldown) {
      results.push({
        chat_id: sub.chat_id,
        address: sub.address || '',
        distanceMeters,
        radiusMeters: radius,
        status: 'cooldown',
        cooldownRemainingSec: Math.ceil((cooldown - (now - sub.last_alert_at)) / 1000),
      });
      continue;
    }

    // Verifica apertura dell'attività secondo il provider configurato
    const openStatus = await evaluateOpenStatus({
      name: sub.address || `Attività ${sub.chat_id}`,
      latitude: sub.latitude,
      longitude: sub.longitude,
      google_place_id: sub.google_place_id,
      opening_hours: sub.opening_hours,
      osm_id: sub.osm_id,
    });

    if (openStatus.open === false) {
      skippedClosed += 1;
      results.push({
        chat_id: sub.chat_id,
        address: sub.address || '',
        distanceMeters,
        radiusMeters: radius,
        status: 'closed',
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

  const status =
    notifiedCount > 0
      ? 'sent'
      : subscribers.length === 0
        ? 'no_recipients'
        : 'no_delivery';

  const startedAt = params.breach?.startedAt ?? now;
  const durationMs = params.breach?.durationMs ?? 0;
  insertNoiseAlert({
    station_id: params.station.id,
    threshold_db: params.breach?.thresholdDb ?? NOISE_ALERT_THRESHOLD_DB,
    started_at: startedAt,
    triggered_at: startedAt + durationMs,
    duration_ms: durationMs,
    recipients: notifiedCount,
    status,
    details: JSON.stringify({
      channel: 'subscribers',
      subscribersEvaluated: subscribers.length,
      skippedClosed,
      provider: getOpenStatusProvider(),
      results,
    }),
  });

  return {
    notifiedCount,
    subscribersEvaluated: subscribers.length,
    skippedClosed,
    results,
  };
}

// ==========================================
// ALLERTE DI PERICOLO (scream / gunshot)
// ==========================================

/**
 * Chat id delle forze dell'ordine destinatarie delle allerte di pericolo.
 * Da AUTHORITY_TELEGRAM_CHAT_IDS (lista separata da virgole). Vuoto = nessuna.
 */
export function getAuthorityChatIds(): string[] {
  return (process.env.AUTHORITY_TELEGRAM_CHAT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Formatta il messaggio Telegram di un evento di PERICOLO (HTML sicuro).
 * Variante per sottoscrittori (con distanza) e per le forze dell'ordine (con coordinate).
 */
export function formatSafetyAlertMessage(params: {
  stationName: string;
  stationId: string;
  latitude: number;
  longitude: number;
  eventType: string;
  confidence?: number;
  audience: 'subscriber' | 'authority';
  distanceMeters?: number;
  userAddress?: string;
  userRadiusMeters?: number;
  timestamp?: number;
  customMessage?: string;
}): string {
  const when = new Date(params.timestamp || Date.now());
  const timeStr = when.toLocaleTimeString('it-IT');
  const dateStr = when.toLocaleDateString('it-IT');

  const label =
    params.eventType === 'gunshot'
      ? '🔫 <b>POSSIBILE SPARO RILEVATO</b>'
      : params.eventType === 'scream'
        ? '🆘 <b>POSSIBILI URLA / RICHIESTA DI AIUTO</b>'
        : params.eventType === 'siren'
          ? '🚨 <b>SIRENA DI EMERGENZA RILEVATA</b>'
          : params.eventType === 'impact_crash'
            ? '💥 <b>FORTE IMPATTO / COLLISIONE RILEVATA</b>'
            : '⚠️ <b>EVENTO CRITICO RILEVATO</b>';
  const confidence =
    params.confidence != null ? ` — confidenza <code>${Math.round(params.confidence * 100)}%</code>` : '';

  const mapUrl = `https://www.openstreetmap.org/?mlat=${params.latitude}&mlon=${params.longitude}#map=19/${params.latitude}/${params.longitude}`;
  const audienceBlock =
    params.audience === 'authority'
      ? `🌐 <b>Coordinate:</b> <a href="${mapUrl}">${params.latitude.toFixed(5)}, ${params.longitude.toFixed(5)}</a>\n` +
        `🎯 <b>Richiesta di verifica/intervento delle forze dell'ordine.</b>`
      : `📍 <b>Distanza dalla tua attività:</b> <b>${Math.round(params.distanceMeters || 0)} metri</b> (entro il tuo raggio di ${params.userRadiusMeters ?? 150}m)\n` +
        `🏢 <b>Tua Sede:</b> ${params.userAddress || 'Indirizzo registrato'}`;

  return `🚨 <b>ALLERTA SICUREZZA URBANA — TORINO</b> 🚨

${label}${confidence}
📡 <b>Cella acustica:</b> <b>${params.stationName}</b> [<code>${params.stationId}</code>]
${audienceBlock}
🕒 <b>Rilevamento:</b> ${dateStr} ore ${timeStr}

${params.customMessage ? `📝 <i>Nota: ${params.customMessage}</i>\n` : ''}⚡ <i>Allerta generata automaticamente dal sistema di monitoraggio acustico urbano.</i>`;
}

/**
 * Inoltra un evento di PERICOLO (scream/gunshot) ai sottoscrittori la cui sede
 * rientra nel proprio raggio dalla stazione, PIÙ alle forze dell'ordine
 * (AUTHORITY_TELEGRAM_CHAT_IDS, senza filtro di raggio). Anti-spam per
 * destinatario. L'esito viene registrato in `noise_alerts` (channel: 'safety').
 */
export async function dispatchSafetyAlertToSubscribers(params: {
  station: { id: string; name: string; latitude: number; longitude: number };
  eventType: string;
  confidence?: number;
  timestamp?: number;
  maxAgeMs?: number;
  customMessage?: string;
  cooldownMs?: number;
}): Promise<{
  notifiedCount: number;
  subscribersEvaluated: number;
  authoritiesNotified: number;
  isStale?: boolean;
  results: Array<{
    chat_id: string;
    audience: 'subscriber' | 'authority';
    status: 'sent' | 'cooldown' | 'error';
    distanceMeters?: number;
    radiusMeters?: number;
    error?: string;
  }>;
}> {
  const now = Date.now();
  const eventTime = params.timestamp || now;
  const maxAge = params.maxAgeMs ?? 2 * 60 * 1000;
  if (Math.abs(now - eventTime) > maxAge) {
    console.warn(
      `[Telegram Safety] Notifica annullata: evento avvenuto ${Math.round((now - eventTime) / 1000)}s fa (limite: ${maxAge / 1000}s).`
    );
    return { notifiedCount: 0, subscribersEvaluated: 0, authoritiesNotified: 0, isStale: true, results: [] };
  }

  const cooldown = params.cooldownMs ?? SAFETY_ALERT_NOTIFY_COOLDOWN_MS;
  const subscribers = getActiveAuthenticatedSubscribers();
  const authorities = getAuthorityChatIds();

  const results: Array<any> = [];
  let notifiedCount = 0;
  let authoritiesNotified = 0;

  // 1) Sottoscrittori entro il proprio raggio di allerta
  for (const sub of subscribers) {
    if (sub.latitude == null || sub.longitude == null) continue;

    const distanceMeters = calculateHaversineDistanceMeters(
      sub.latitude,
      sub.longitude,
      params.station.latitude,
      params.station.longitude
    );
    const radius = sub.alert_radius_meters || 150;
    if (distanceMeters > radius) continue;

    if (sub.last_alert_at && now - sub.last_alert_at < cooldown) {
      results.push({ chat_id: sub.chat_id, audience: 'subscriber', status: 'cooldown', distanceMeters, radiusMeters: radius });
      continue;
    }

    const text = formatSafetyAlertMessage({
      stationName: params.station.name,
      stationId: params.station.id,
      latitude: params.station.latitude,
      longitude: params.station.longitude,
      eventType: params.eventType,
      confidence: params.confidence,
      audience: 'subscriber',
      distanceMeters,
      userAddress: sub.address || undefined,
      userRadiusMeters: radius,
      timestamp: now,
      customMessage: params.customMessage,
    });

    const sendRes = await sendTelegramMessage(sub.chat_id, text, 'HTML');
    if (sendRes.ok || sendRes.success) {
      updateSubscriberLastAlert(sub.chat_id, now);
      notifiedCount++;
      results.push({ chat_id: sub.chat_id, audience: 'subscriber', status: 'sent', distanceMeters, radiusMeters: radius });
    } else {
      results.push({ chat_id: sub.chat_id, audience: 'subscriber', status: 'error', distanceMeters, radiusMeters: radius, error: sendRes.error });
    }
  }

  // 2) Forze dell'ordine: nessun filtro di raggio; si invia a ogni evento rilevato
  for (const chatId of authorities) {
    const text = formatSafetyAlertMessage({
      stationName: params.station.name,
      stationId: params.station.id,
      latitude: params.station.latitude,
      longitude: params.station.longitude,
      eventType: params.eventType,
      confidence: params.confidence,
      audience: 'authority',
      timestamp: now,
      customMessage: params.customMessage,
    });
    const sendRes = await sendTelegramMessage(chatId, text, 'HTML');
    if (sendRes.ok || sendRes.success) {
      authoritiesNotified++;
      results.push({ chat_id: chatId, audience: 'authority', status: 'sent' });
    } else {
      results.push({ chat_id: chatId, audience: 'authority', status: 'error', error: sendRes.error });
    }
  }

  const total = notifiedCount + authoritiesNotified;
  const status =
    total > 0
      ? 'sent'
      : subscribers.length === 0 && authorities.length === 0
        ? 'no_recipients'
        : 'no_delivery';

  insertNoiseAlert({
    station_id: params.station.id,
    threshold_db: 0,
    started_at: eventTime,
    triggered_at: eventTime,
    duration_ms: 0,
    recipients: total,
    status,
    details: JSON.stringify({
      channel: 'safety',
      kind: params.eventType,
      confidence: params.confidence ?? null,
      subscribersNotified: notifiedCount,
      authoritiesNotified,
      subscribersEvaluated: subscribers.length,
      authoritiesEvaluated: authorities.length,
      results,
    }),
  });

  return {
    notifiedCount,
    subscribersEvaluated: subscribers.length,
    authoritiesNotified,
    results,
  };
}

// ==========================================
// ONBOARDING ISCRITTI (auth key + indirizzo)
// ==========================================

/**
 * Gestisce l'onboarding self-service degli iscritti: autenticazione con chiave
 * univoca, impostazione dell'indirizzo torinese, raggio, riepiloghi e /stop.
 * Porting del runner `scripts/telegram_bot.mjs` in un handler condiviso, così
 * funziona sia in long-polling sia via webhook.
 */
export async function handleSubscriberUpdate(update: any): Promise<void> {
  const message = update?.message;
  const chatId = message?.chat?.id;
  const rawText: string = message?.text ? String(message.text).trim() : '';
  const username: string = message?.from?.username || '';
  const firstName: string = message?.from?.first_name || 'Utente';

  if (!chatId || !rawText) return;

  const chatIdStr = String(chatId);
  const subscriber = getTelegramSubscriber(chatIdStr);
  const isAuth = Boolean(subscriber && subscriber.is_authenticated);

  console.log(`[telegram] Chat ${chatIdStr} (${firstName}): "${rawText}" | Auth: ${isAuth}`);

  // 1. Comando /start
  if (rawText.startsWith('/start')) {
    const possibleKey = rawText.split(/\s+/)[1];

    if (possibleKey) {
      const redeem = redeemBotAuthKey(possibleKey, chatIdStr);
      if (redeem.success) {
        await sendTelegramMessage(
          chatIdStr,
          `✅ <b>Autenticazione riuscita con successo!</b>\n\n` +
            `🏢 <b>Attività:</b> ${redeem.business_name || 'Attività registrata'}\n` +
            `📍 <b>Sede Registrata:</b> ${redeem.address || 'Torino'}\n` +
            (redeem.latitude ? `🌐 <b>Coordinate:</b> <code>${redeem.latitude.toFixed(5)}° N, ${redeem.longitude!.toFixed(5)}° E</code>\n` : '') +
            `📏 <b>Raggio Allerta:</b> <b>${redeem.alert_radius_meters || 150} metri</b>\n\n` +
            `🟢 <b>Monitoraggio ATTIVO:</b> <i>Riceverai avvisi automatici in tempo reale se il rumore attorno alla tua attività supera i 70 dB.</i>`
        );
        return;
      }
      await sendTelegramMessage(
        chatIdStr,
        `❌ <b>Autenticazione non riuscita:</b>\n${redeem.error || 'Chiave non valida o già utilizzata.'}\n\n` +
          `Richiedi una nuova chiave monouso all'amministratore del servizio.`
      );
      return;
    }

    if (isAuth && subscriber) {
      const radius = subscriber.alert_radius_meters || 150;
      await sendTelegramMessage(
        chatIdStr,
        `👋 Bentornato <b>${firstName}</b>!\n\n` +
          `🏢 <b>Sede Registrata:</b> ${subscriber.address || 'Torino'}\n` +
          `📏 <b>Raggio di allerta:</b> <b>${radius} metri</b>\n\n` +
          `<b>Comandi disponibili:</b>\n` +
          `• <code>/stazioni</code> - Elenco sensori nel tuo perimetro (${radius}m)\n` +
          `• <code>/raggio &lt;metri&gt;</code> - Modifica raggio di copertura (es: /raggio 150)\n` +
          `• <code>/stato</code> - Riepilogo configurazione attiva\n` +
          `• <code>/test_allerta</code> - Simula una notifica di rumore critico\n` +
          `• <code>/stop</code> - Disattiva le notifiche\n` +
          `• <code>/aiuto</code> - Guida comandi`
      );
      return;
    }

    upsertTelegramSubscriber({ chat_id: chatIdStr, username, first_name: firstName, is_active: 1 });
    await sendTelegramMessage(
      chatIdStr,
      `👋 <b>Benvenuto nel Sistema Allerte Acustiche Torino Noise!</b>\n\n` +
        `Questo bot monitora le emissioni sonore urbane attorno alla tua attività e ti invia avvisi istantanei se il rumore supera i livelli consentiti.\n\n` +
        `🔑 <b>Attivazione Profilo Esercente:</b>\n` +
        `Scrivi <b>/start</b> o <b>/chiave</b> per attivare il profilo della tua attività:\n\n` +
        `• Digita <code>/chiave &lt;CODICE&gt;</code> (es: <code>/chiave TN-XXXX-XXXX-XXXX</code>)\n` +
        `• Oppure digita <code>/login &lt;CODICE&gt;</code> o invia direttamente la chiave monouso fornita dall'amministrazione.`
    );
    return;
  }

  // 2. Comando /stop: disattiva le notifiche preservando la registrazione
  if (rawText === '/stop') {
    if (subscriber) {
      setSubscriberActive(chatIdStr, 0);
      await sendTelegramMessage(
        chatIdStr,
        `🔕 <b>Notifiche disattivate.</b>\n\nNon riceverai più allerte acustiche. ` +
          `La tua configurazione è conservata: invia /start per riattivarle.`
      );
    } else {
      await sendTelegramMessage(chatIdStr, `ℹ️ Nessuna registrazione attiva da disattivare.`);
    }
    return;
  }

  // 3. Comando /chiave o /login o tentativo di autenticazione tramite testo
  if (rawText.startsWith('/login') || rawText.startsWith('/chiave') || !isAuth) {
    let keyToTest = rawText;
    if (rawText.startsWith('/login') || rawText.startsWith('/chiave')) {
      keyToTest = rawText.split(/\s+/).slice(1).join(' ').trim();
    }

    if (!keyToTest) {
      await sendTelegramMessage(
        chatIdStr,
        `⚠️ <b>Inserisci la tua chiave per attivare il profilo:</b>\n\n` +
        `Digita il comando seguito dal codice rilasciato dall'amministratore, ad esempio:\n` +
        `<code>/chiave TN-XXXX-XXXX-XXXX</code>\n` +
        `oppure:\n` +
        `<code>/login TN-XXXX-XXXX-XXXX</code>`
      );
      return;
    }

    const redeem = redeemBotAuthKey(keyToTest, chatIdStr);
    if (redeem.success) {
      await sendTelegramMessage(
        chatIdStr,
        `✅ <b>Autenticazione riuscita!</b>\n\n` +
          `🏢 <b>Attività:</b> ${redeem.business_name || 'Attività registrata'}\n` +
          `📍 <b>Sede Registrata:</b> ${redeem.address || 'Torino'}\n` +
          (redeem.latitude ? `🌐 <b>Coordinate:</b> <code>${redeem.latitude.toFixed(5)}° N, ${redeem.longitude!.toFixed(5)}° E</code>\n` : '') +
          `📏 <b>Raggio Allerta:</b> <b>${redeem.alert_radius_meters || 150} metri</b>\n\n` +
          `🟢 <b>Monitoraggio ATTIVO:</b> <i>Riceverai avvisi automatici in tempo reale se il rumore attorno alla tua attività supera i 70 dB.</i>`
      );
      return;
    }

    await sendTelegramMessage(
      chatIdStr,
      `❌ <b>Autenticazione non riuscita:</b>\n${redeem.error || 'Chiave non valida o già utilizzata.'}\n\n` +
        `Assicurati di inserire la chiave monouso fornita dall'amministratore.`
    );
    return;
  }

  // DA QUI IN POI L'UTENTE È AUTENTICATO
  if (!subscriber) return;

  // 4. Modifica raggio: /raggio <metri>
  if (rawText.startsWith('/raggio')) {
    const newRadius = parseFloat(rawText.split(/\s+/)[1]);

    if (!newRadius || isNaN(newRadius) || newRadius < 20 || newRadius > 5000) {
      await sendTelegramMessage(
        chatIdStr,
        `⚠️ Raggio non valido. Inserisci un valore tra 20 e 5000 metri.\nEsempio: <code>/raggio 150</code>`
      );
      return;
    }

    upsertTelegramSubscriber({ chat_id: chatIdStr, alert_radius_meters: newRadius });
    const updated = getTelegramSubscriber(chatIdStr);

    let stationsMsg = '';
    if (updated && updated.latitude && updated.longitude) {
      const inRange = findStationsInRange(updated.latitude, updated.longitude, newRadius);
      stationsMsg =
        inRange.length > 0
          ? `\n\n📡 <b>Celle/Sensori coperti (${inRange.length}):</b>\n` +
            inRange.map((m) => `• <b>${m.station.name}</b> (a ${Math.round(m.distanceMeters)}m)`).join('\n')
          : `\n\nℹ️ <i>Nessuna stazione attualmente presente entro ${newRadius}m dalla tua sede.</i>`;
    }

    await sendTelegramMessage(chatIdStr, `🎯 <b>Raggio di allerta aggiornato a ${newRadius} metri!</b>${stationsMsg}`);
    return;
  }

  // 5. Elenco stazioni nel perimetro: /stazioni
  if (rawText === '/stazioni') {
    if (!subscriber.latitude || !subscriber.longitude) {
      await sendTelegramMessage(chatIdStr, `⚠️ Devi prima impostare un indirizzo. Invia via e numero civico (es: <code>Via Po 14</code>).`);
      return;
    }

    const radius = subscriber.alert_radius_meters || 150;
    const inRange = findStationsInRange(subscriber.latitude, subscriber.longitude, radius);

    if (inRange.length === 0) {
      await sendTelegramMessage(
        chatIdStr,
        `ℹ️ <b>Nessuna cella acustica entro ${radius}m dalla tua sede.</b>\n` +
          `🏢 Sede: ${subscriber.address}\n` +
          `Puoi ampliare il perimetro con <code>/raggio &lt;metri&gt;</code> (es: <code>/raggio 300</code>).`
      );
    } else {
      const list = inRange
        .map((m, idx) => `${idx + 1}. <b>${m.station.name}</b> [<code>${m.station.id}</code>]\n   ↳ Distanza: <b>${Math.round(m.distanceMeters)} metri</b>`)
        .join('\n\n');
      await sendTelegramMessage(
        chatIdStr,
        `📡 <b>Celle Acustiche attive nel tuo raggio di ${radius}m (${inRange.length}):</b>\n\n${list}\n\n` +
          `🔔 <i>Riceverai un avviso se una di queste stazioni rileva rumori oltre soglia.</i>`
      );
    }
    return;
  }

  // 6. Stato del monitoraggio: /stato (alias /status)
  if (rawText === '/stato' || rawText === '/status') {
    const radius = subscriber.alert_radius_meters || 150;
    let countInRange = 0;

    if (subscriber.latitude && subscriber.longitude) {
      countInRange = findStationsInRange(subscriber.latitude, subscriber.longitude, radius).length;
    }

    await sendTelegramMessage(
      chatIdStr,
      `📊 <b>STATO DEL MONITORAGGIO ACUSTICO</b>\n\n` +
        `👤 <b>Utente:</b> ${firstName} (@${username || 'N/A'})\n` +
        `🔑 <b>Chiave:</b> <code>${subscriber.auth_key}</code> (Attiva)\n` +
        `🏢 <b>Sede:</b> ${subscriber.address || '<i>Da configurare</i>'}\n` +
        `📍 <b>Coordinate:</b> ${subscriber.latitude ? `${subscriber.latitude.toFixed(5)}° N, ${subscriber.longitude!.toFixed(5)}° E` : 'Non impostate'}\n` +
        `📏 <b>Raggio Monitorato:</b> <b>${radius} metri</b>\n` +
        `📡 <b>Celle in ascolto nel raggio:</b> <b>${countInRange} stazioni</b>\n` +
        `🟢 <b>Stato Allerte:</b> <b>${subscriber.is_active ? 'ATTIVO' : 'DISATTIVATO'}</b>`
    );
    return;
  }

  // 7. Test di allerta simulata: /test_allerta
  if (rawText === '/test_allerta') {
    const radius = subscriber.alert_radius_meters || 150;
    const addr = subscriber.address || 'Via di Prova 1, Torino';
    await sendTelegramMessage(
      chatIdStr,
      `🚨 <b>TEST ALLERTA RUMORE CRITICO A TORINO</b> 🚨\n\n` +
        `⚠️ <b>Livello Acustico Simulato:</b> <code>88 dB</code> (ALLARME ROSSO)\n` +
        `📡 <b>Cella Acustica:</b> <b>Arduino Uno Q Test</b> [<code>ard-uno-q-real-mic</code>]\n` +
        `📍 <b>Distanza dalla tua attività:</b> <b>42 metri</b> (Entro il tuo raggio di ${radius}m)\n` +
        `🏢 <b>Tua Sede:</b> ${addr}\n` +
        `🕒 <b>Rilevamento:</b> ${new Date().toLocaleTimeString('it-IT')}\n\n` +
        `✅ <i>Questo è un messaggio di test. Il tuo canale di ricezione Telegram funziona perfettamente!</i>`
    );
    return;
  }

  // 8. Aiuto: /aiuto (alias /help)
  if (rawText === '/aiuto' || rawText === '/help') {
    await sendTelegramMessage(
      chatIdStr,
      `📖 <b>GUIDA COMANDI BOT TORINO NOISE</b>\n\n` +
        `• <code>/stazioni</code> - Elenco sensori nel tuo perimetro di monitoraggio\n` +
        `• <code>/raggio &lt;metri&gt;</code> - Modifica raggio di allerta (default: 150m, es: /raggio 200)\n` +
        `• <code>/stato</code> - Riepilogo sede registrata, coordinate e timer anti-spam\n` +
        `• <code>/test_allerta</code> - Invia una simulazione di allerta sonora\n` +
        `• <code>/stop</code> - Disattiva temporaneamente le notifiche\n\n` +
        `🔒 <i>Nota: La sede della tua attività è certificata e pre-configurata dall'amministrazione comunale all'attivazione della chiave monouso.</i>`
    );
    return;
  }

  // 9. Ricezione testo libero da utente autenticato: promemoria della sede certificata dall'amministrazione
  await sendTelegramMessage(
    chatIdStr,
    `ℹ️ <b>Sede della tua attività già registrata:</b>\n` +
      `🏢 <b>${subscriber.address || 'Torino'}</b>\n\n` +
      `🔒 <i>Per garantire la massima precisione ed evitare errori di sintassi o localizzazione, la sede è gestita e validata direttamente dall'amministrazione comunale.</i>\n\n` +
      `• Usa <code>/stazioni</code> per verificare le celle nel tuo perimetro.\n` +
      `• Usa <code>/stato</code> per consultare la tua configurazione attiva.\n` +
      `• Se devi modificare o correggere la sede, contatta l'amministratore del servizio.`
  );
}

/** Stazioni entro il raggio, ordinate per distanza crescente. */
function findStationsInRange(lat: number, lon: number, radiusMeters: number) {
  return getAllStations()
    .map((station) => ({
      station,
      distanceMeters: calculateHaversineDistanceMeters(lat, lon, station.latitude, station.longitude),
    }))
    .filter((m) => m.distanceMeters <= radiusMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}

// ==========================================
// COLLEGAMENTO AZIENDE (modello a slug)
// ==========================================

async function handleCompanyLink(chatId: string, slug: string): Promise<void> {
  const company = linkTelegramChat(slug, chatId);
  if (!company) {
    await sendTelegramMessage(chatId, `Nessun esercizio trovato con slug "${slug}". Verifica il codice e riprova.`);
    return;
  }

  await sendTelegramMessage(
    chatId,
    `Collegamento completato. Riceverai qui le allerte acustiche per:\n` +
      `• ${company.name} (${company.slug})\n\n` +
      `Quando il rumore resta elevato per oltre 10 minuti ti chiederemo di intervenire. ` +
      `Invia /status per la verifica o /stop per disattivare le notifiche.`
  );
}

async function handleCompanyStatus(chatId: string): Promise<void> {
  const companies = getCompaniesByChatId(chatId);
  if (companies.length === 0) {
    await sendTelegramMessage(chatId, 'Nessun esercizio collegato. Invia /start <slug> per iniziare.');
    return;
  }
  const lines = companies.map((c) => `• ${c.name} (${c.slug})`).join('\n');
  await sendTelegramMessage(chatId, `Esercizi collegati a questa chat:\n${lines}`);
}

async function handleCompanyStop(chatId: string): Promise<void> {
  const removed = unlinkTelegramChat(chatId);
  await sendTelegramMessage(
    chatId,
    removed > 0
      ? 'Notifiche disattivate. Non riceverai più allerte acustiche. Invia /start <slug> per riattivarle.'
      : 'Questa chat non era collegata ad alcun esercizio.'
  );
}

async function handleCompanyHelp(chatId: string): Promise<void> {
  await sendTelegramMessage(
    chatId,
    'Comandi disponibili:\n' +
      '/start <slug> — collega un esercizio\n' +
      '/status — mostra gli esercizi collegati\n' +
      '/stop — disattiva le notifiche\n\n' +
      'Sei un esercente? Invia /start e la tua chiave univoca per registrarti.'
  );
}

// ==========================================
// ROUTER DEGLI UPDATE
// ==========================================

/**
 * Instrada un update della Bot API verso il flusso corretto:
 * onboarding iscritti (chiave + indirizzo) oppure collegamento aziende (slug).
 */
export async function handleTelegramUpdate(update: any): Promise<void> {
  const message = update?.message;
  const text: string | undefined = message?.text;
  const chatId: number | string | undefined = message?.chat?.id;

  if (!chatId || !text) return;

  const chatIdStr = String(chatId);
  const [rawCommand, ...args] = text.trim().split(/\s+/);
  const command = rawCommand.toLowerCase().split('@')[0];
  const subscriber = getTelegramSubscriber(chatIdStr);

  // /start <slug> => collegamento azienda, a meno che non sia una chiave o un iscritto
  if (command === '/start') {
    const arg = args[0];
    if (arg && !subscriber && !verifyBotAuthKey(arg) && getCompanyBySlug(arg)) {
      return handleCompanyLink(chatIdStr, arg);
    }
    return handleSubscriberUpdate(update);
  }

  // I non iscritti possono usare i comandi azienda
  if (!subscriber) {
    if (command === '/stop') return handleCompanyStop(chatIdStr);
    if (command === '/status' || command === '/stato') return handleCompanyStatus(chatIdStr);
    if (command === '/help' || command === '/aiuto') return handleCompanyHelp(chatIdStr);
  }

  return handleSubscriberUpdate(update);
}

/**
 * Registra i comandi del Bot con la Telegram Bot API per mostrare il menu
 * popup di autocompletamento quando l'utente digita "/" in chat.
 */
export async function setMyTelegramCommands(): Promise<{ ok: boolean; error?: string }> {
  const token = getBotToken();
  if (!token) return { ok: false, error: 'Token non configurato' };

  const commands = [
    { command: 'start', description: 'Avvia il bot e inserisci la chiave univoca' },
    { command: 'raggio', description: 'Imposta il raggio di allerta in metri (es: /raggio 150)' },
    { command: 'stazioni', description: 'Elenco celle acustiche monitorate nel tuo raggio' },
    { command: 'stato', description: 'Riepilogo sede, coordinate, raggio e timer anti-spam' },
    { command: 'test_allerta', description: 'Invia una notifica di prova simulata' },
    { command: 'aiuto', description: 'Guida e istruzioni per configurare la tua attività' },
  ];

  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      return { ok: true };
    }
    return { ok: false, error: data.description || res.statusText };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
