import {
  upsertNoiseBreach,
  getNoiseBreach,
  deleteNoiseBreach,
  getStationById,
  getCompaniesWithTelegram,
  insertNoiseAlert,
} from '@/lib/db';
import { haversineMeters } from '@/lib/google-maps';
import { evaluateOpenStatus, getOpenStatusProvider } from '@/lib/open-status';
import { sendTelegramMessage, dispatchNoiseAlertToSubscribers } from '@/lib/telegram';
import {
  NOISE_ALERT_THRESHOLD_DB,
  NOISE_ALERT_PERSISTENCE_MS,
  NOISE_ALERT_QUIET_GRACE_MS,
  NOISE_ALERT_NOTIFY_COOLDOWN_MS,
  COMPANY_ALERT_RADIUS_METERS,
} from '@/lib/constants';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getThresholdDb(): number {
  return envInt('NOISE_ALERT_THRESHOLD_DB', NOISE_ALERT_THRESHOLD_DB);
}

function getPersistenceMs(): number {
  return envInt('NOISE_ALERT_PERSISTENCE_MINUTES', NOISE_ALERT_PERSISTENCE_MS / 60000) * 60000;
}

function getQuietGraceMs(): number {
  return envInt('NOISE_ALERT_QUIET_GRACE_MINUTES', NOISE_ALERT_QUIET_GRACE_MS / 60000) * 60000;
}

function getNotifyCooldownMs(): number {
  return envInt('NOISE_ALERT_COOLDOWN_MINUTES', NOISE_ALERT_NOTIFY_COOLDOWN_MS / 60000) * 60000;
}

function getCompanyRadiusMeters(): number {
  return envInt('COMPANY_ALERT_RADIUS_METERS', COMPANY_ALERT_RADIUS_METERS);
}

export interface BreachEvaluation {
  breachActive: boolean;
  shouldAlert: boolean;
  startedAt: number | null;
  durationMs: number;
  thresholdDb: number;
}

/**
 * Aggiorna lo stato di violazione sonora di una stazione a partire da una nuova
 * lettura e decide se è ora di inviare un'allerta agli esercenti.
 *
 * Regola: rumore sopra soglia in modo continuativo per >= PERSISTENZA (10 min).
 * Brevi pause sotto soglia (entro la tolleranza) non azzerano la violazione.
 */
export function evaluateNoiseBreach(
  stationId: string,
  intensity: number,
  timestamp: number
): BreachEvaluation {
  const thresholdDb = getThresholdDb();
  const persistenceMs = getPersistenceMs();
  const quietGraceMs = getQuietGraceMs();
  const cooldownMs = getNotifyCooldownMs();

  const existing = getNoiseBreach(stationId);

  if (intensity > thresholdDb) {
    let startedAt = timestamp;
    let notifiedAt = existing?.notified_at ?? null;
    let alertCount = existing?.alert_count ?? 0;

    if (existing && existing.quiet_since === null) {
      startedAt = existing.started_at;
    } else if (existing && existing.quiet_since !== null) {
      const withinGrace = timestamp - existing.quiet_since <= quietGraceMs;
      startedAt = withinGrace ? existing.started_at : timestamp;
      if (!withinGrace) {
        // La pausa è stata abbastanza lunga: si tratta di una nuova violazione
        notifiedAt = null;
        alertCount = 0;
      }
    }

    const durationMs = timestamp - startedAt;
    const isStale = Math.abs(Date.now() - timestamp) > (2 * 60 * 1000);
    const shouldAlert =
      !isStale &&
      durationMs >= persistenceMs &&
      (notifiedAt === null || timestamp - notifiedAt >= cooldownMs);

    if (shouldAlert) {
      notifiedAt = timestamp;
      alertCount += 1;
    }

    upsertNoiseBreach({
      station_id: stationId,
      started_at: startedAt,
      last_high_at: timestamp,
      quiet_since: null,
      notified_at: notifiedAt,
      alert_count: alertCount,
    });

    return { breachActive: true, shouldAlert, startedAt, durationMs, thresholdDb };
  }

  // Lettura sotto soglia
  if (existing) {
    if (existing.quiet_since === null) {
      upsertNoiseBreach({ ...existing, quiet_since: timestamp });
      return {
        breachActive: true,
        shouldAlert: false,
        startedAt: existing.started_at,
        durationMs: timestamp - existing.started_at,
        thresholdDb,
      };
    }

    const stillWithinGrace = timestamp - existing.quiet_since <= quietGraceMs;
    if (!stillWithinGrace) {
      deleteNoiseBreach(stationId);
      return { breachActive: false, shouldAlert: false, startedAt: null, durationMs: 0, thresholdDb };
    }

    return {
      breachActive: true,
      shouldAlert: false,
      startedAt: existing.started_at,
      durationMs: timestamp - existing.started_at,
      thresholdDb,
    };
  }

  return { breachActive: false, shouldAlert: false, startedAt: null, durationMs: 0, thresholdDb };
}

export interface AlertDispatchResult {
  stationId: string;
  recipientsConsidered: number;
  recipientsNotified: number;
  skippedClosed: number;
  failed: number;
  status: string;
}

function buildAlertMessage(companyName: string, stationName: string, evaluation: BreachEvaluation): string {
  const minutes = Math.max(1, Math.round(evaluation.durationMs / 60000));
  return (
    `ALLERTA RUMORE — ${stationName}\n\n` +
    `Gentile ${companyName}, la stazione acustica rileva un livello sonoro elevato ` +
    `(oltre ${evaluation.thresholdDb} dB) da oltre ${minutes} minuti.\n\n` +
    `Vi invitiamo a ridurre il volume delle persone presenti per rientrare nei limiti.\n\n` +
    `Se la situazione non si risolve, le autorità competenti verranno informate.`
  );
}

/**
 * Invia l'allerta Telegram agli esercenti limitrofi alla stazione che risultano
 * aperti secondo Google Maps (se lo stato è sconosciuto si procede comunque).
 */
export async function dispatchNoiseAlert(
  stationId: string,
  evaluation: BreachEvaluation
): Promise<AlertDispatchResult> {
  const station = getStationById(stationId);
  const radiusMeters = getCompanyRadiusMeters();

  const candidates = getCompaniesWithTelegram().filter((company) => {
    if (!station) return true;
    const distance = haversineMeters(
      station.latitude,
      station.longitude,
      company.latitude,
      company.longitude
    );
    return distance <= radiusMeters;
  });

  let recipientsNotified = 0;
  let skippedClosed = 0;
  let failed = 0;

  for (const company of candidates) {
    const status = await evaluateOpenStatus(company);
    if (status.open === false) {
      skippedClosed += 1;
      continue;
    }

    const result = await sendTelegramMessage(
      company.telegram_chat_id!,
      buildAlertMessage(company.name, station?.name ?? stationId, evaluation)
    );

    if (result.ok) recipientsNotified += 1;
    else if (!result.skipped) failed += 1;
  }

  const status =
    recipientsNotified > 0
      ? 'sent'
      : candidates.length === 0
        ? 'no_recipients'
        : 'no_delivery';

  const breachStartedAt = evaluation.startedAt ?? 0;
  insertNoiseAlert({
    station_id: stationId,
    threshold_db: evaluation.thresholdDb,
    started_at: breachStartedAt,
    triggered_at: breachStartedAt + evaluation.durationMs,
    duration_ms: evaluation.durationMs,
    recipients: recipientsNotified,
    status,
    details: JSON.stringify({
      candidates: candidates.length,
      skippedClosed,
      failed,
      provider: getOpenStatusProvider(),
    }),
  });

  return {
    stationId,
    recipientsConsidered: candidates.length,
    recipientsNotified,
    skippedClosed,
    failed,
    status,
  };
}

export interface SubscriberDispatchSummary {
  notifiedCount: number;
  subscribersEvaluated: number;
  skippedClosed: number;
}

export interface AlertProcessingResult {
  alerted: boolean;
  evaluation: BreachEvaluation | null;
  dispatch?: AlertDispatchResult;
  subscribers?: SubscriberDispatchSummary;
}

/**
 * Punto di ingresso usato dal percorso di telemetria: valuta la violazione e,
 * se necessario, invia l'allerta. Non solleva mai eccezioni verso l'ingest.
 *
 * La stessa valutazione (regola dei 10 minuti) governa entrambi i canali:
 * gli esercenti registrati (company) e gli iscritti self-service del bot.
 */
export async function processReadingForAlerts(
  stationId: string,
  intensity: number,
  timestamp: number
): Promise<AlertProcessingResult> {
  try {
    const evaluation = evaluateNoiseBreach(stationId, intensity, timestamp);
    if (!evaluation.shouldAlert) {
      return { alerted: false, evaluation };
    }

    const station = getStationById(stationId);

    const [dispatch, subscriberResult] = await Promise.all([
      dispatchNoiseAlert(stationId, evaluation),
      station
        ? dispatchNoiseAlertToSubscribers({
            station: {
              id: station.id,
              name: station.name,
              latitude: station.latitude,
              longitude: station.longitude,
            },
            soundIntensity: intensity,
            breach: {
              startedAt: evaluation.startedAt ?? timestamp,
              durationMs: evaluation.durationMs,
              thresholdDb: evaluation.thresholdDb,
            },
          })
        : Promise.resolve(null),
    ]);

    return {
      alerted: true,
      evaluation,
      dispatch,
      subscribers: subscriberResult
        ? {
            notifiedCount: subscriberResult.notifiedCount,
            subscribersEvaluated: subscriberResult.subscribersEvaluated,
            skippedClosed: subscriberResult.skippedClosed,
          }
        : undefined,
    };
  } catch (error: any) {
    console.error('[alerts] Errore durante la valutazione dell\'allerta:', error?.message || error);
    return { alerted: false, evaluation: null };
  }
}
