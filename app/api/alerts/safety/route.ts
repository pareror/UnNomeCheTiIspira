import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  verifySensorApiKey,
  verifyAdminApiKey,
  applySecurityHeaders,
  checkRateLimit,
} from '@/lib/security';
import { getStationById, upsertStation } from '@/lib/db';
import { dispatchSafetyAlertToSubscribers } from '@/lib/telegram';
import { MAX_ALERT_EVENT_AGE_MS } from '@/lib/constants';

export const dynamic = 'force-dynamic';

const SafetyAlertSchema = z.object({
  station_id: z
    .string()
    .min(2, 'station_id obbligatorio')
    .max(64, 'station_id troppo lungo')
    .regex(/^[a-zA-Z0-9_-]+$/, 'station_id contiene caratteri non validi'),
  event_type: z.enum(['scream', 'gunshot', 'siren', 'impact_crash', 'other']).default('other'),
  confidence: z.number().min(0).max(1).optional(),
  timestamp: z.number().int().positive().optional(),
  message: z.string().max(300).optional(),
  // Metadati opzionali per auto-registrazione della stazione
  name: z.string().max(100).optional(),
  latitude: z.number().min(44.5).max(45.5).optional(),
  longitude: z.number().min(7.2).max(8.2).optional(),
  api_key: z.string().optional(),
});

export async function POST(request: NextRequest) {
  // 1. Parsing del payload
  let rawBody: any;
  try {
    rawBody = await request.json();
  } catch {
    return applySecurityHeaders(
      NextResponse.json({ error: 'Formato richiesta non valido (richiesto JSON)' }, { status: 400 })
    );
  }

  // 2. Autenticazione (chiave sensore o admin)
  const isAuthorized = verifySensorApiKey(request, rawBody?.api_key) || verifyAdminApiKey(request);
  if (!isAuthorized) {
    return applySecurityHeaders(
      NextResponse.json(
        {
          error: 'Accesso negato: API Key non valida o mancante',
          help: "Fornire x-api-key nell'header della richiesta o nel campo api_key del body JSON",
        },
        { status: 401 }
      )
    );
  }

  // 3. Rate limiting (anti-DoS)
  const clientIp = request.headers.get('x-forwarded-for') || 'local-safety-client';
  const rateStatus = checkRateLimit(`alert_safety_${clientIp}`, 30, 60_000);
  if (!rateStatus.allowed) {
    return applySecurityHeaders(
      NextResponse.json({ error: 'Frequenza invio allerte troppo elevata. Riprovare tra poco.' }, { status: 429 })
    );
  }

  // 4. Validazione schema
  const validation = SafetyAlertSchema.safeParse(rawBody);
  if (!validation.success) {
    return applySecurityHeaders(
      NextResponse.json(
        { error: 'Dati di allerta non conformi', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      )
    );
  }

  const { station_id, event_type, confidence, message, name, latitude, longitude } = validation.data;

  // 4.1. Soglia minima di confidenza: invia la notifica su Telegram SOLO se confidenza > 80% (> 0.80)
  if (confidence != null && confidence <= 0.80) {
    return applySecurityHeaders(
      NextResponse.json({
        success: true,
        alert_triggered: false,
        message: `Notifica Telegram ignorata: livello di confidenza (${(confidence * 100).toFixed(1)}%) non superiore alla soglia richiesta dell'80%.`,
        confidence,
        required_min_confidence: 0.80,
      })
    );
  }

  // 5. Freschezza temporale: un evento di pericolo deve essere recente
  const now = Date.now();
  const eventTime = validation.data.timestamp ?? now;
  if (Math.abs(now - eventTime) > MAX_ALERT_EVENT_AGE_MS) {
    return applySecurityHeaders(
      NextResponse.json({
        success: true,
        alert_triggered: false,
        message: `Evento di pericolo ignorato: risale a oltre ${Math.round(MAX_ALERT_EVENT_AGE_MS / 60000)} minuti fa. Nessun avviso inviato.`,
        event_timestamp: eventTime,
        server_timestamp: now,
      })
    );
  }

  // 6. Stazione: recupera o auto-registra (l'evento può precedere qualsiasi lettura dB)
  let station = getStationById(station_id);
  if (!station) {
    station = upsertStation({ id: station_id, name, latitude, longitude });
  }

  // 7. Fan-out Telegram: sottoscrittori entro il proprio raggio + forze dell'ordine
  try {
    const result = await dispatchSafetyAlertToSubscribers({
      station: {
        id: station.id,
        name: station.name,
        latitude: station.latitude,
        longitude: station.longitude,
      },
      eventType: event_type,
      confidence,
      timestamp: eventTime,
      customMessage: message,
    });

    return applySecurityHeaders(
      NextResponse.json({
        success: true,
        alert_triggered: true,
        station: {
          id: station.id,
          name: station.name,
          latitude: station.latitude,
          longitude: station.longitude,
        },
        event_type,
        confidence: confidence ?? null,
        subscribers_notified: result.notifiedCount,
        authorities_notified: result.authoritiesNotified,
        total_subscribers_evaluated: result.subscribersEvaluated,
        details: result.results,
        timestamp: Date.now(),
      })
    );
  } catch (error: any) {
    console.error('[Safety Alert API] Errore durante l\'invio delle allerte Telegram:', error);
    return applySecurityHeaders(
      NextResponse.json(
        { error: error.message || 'Errore interno durante la notifica Telegram' },
        { status: 500 }
      )
    );
  }
}

// Endpoint GET informativo per documentazione dell'API protetta
export async function GET() {
  return applySecurityHeaders(
    NextResponse.json({
      endpoint: 'POST /api/alerts/safety',
      description:
        'API protetta per notificare via Telegram un evento di PERICOLO (urla/gunshot): sottoscrittori nel loro raggio + forze dell\'ordine (AUTHORITY_TELEGRAM_CHAT_IDS)',
      security: {
        authentication: 'Header x-api-key o Bearer token obbligatorio',
        rate_limit: '30 richieste/minuto',
      },
      required_body_fields: {
        station_id: 'ID della stazione acustica/cella (es. ard-uno-q-real)',
        event_type: "scream | gunshot | other",
      },
      optional_fields: {
        confidence: 'Probabilità del classificatore (0..1)',
        timestamp: 'Timestamp epoch ms dell\'evento (max 2 minuti di età)',
        message: 'Nota/descrizione aggiuntiva',
        name: 'Nome stazione (auto-registrazione se assente)',
        latitude: 'Latitudine stazione (auto-registrazione)',
        longitude: 'Longitudine stazione (auto-registrazione)',
      },
    })
  );
}
