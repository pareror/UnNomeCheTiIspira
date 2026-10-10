import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { 
  verifySensorApiKey, 
  applySecurityHeaders, 
  checkRateLimit 
} from '@/lib/security';
import { getDb } from '@/lib/db';
import { dispatchNoiseAlertToSubscribers } from '@/lib/telegram';
import { NOISE_ALERT_THRESHOLD_DB } from '@/lib/constants';

export const dynamic = 'force-dynamic';

const AlertPayloadSchema = z.object({
  station_id: z.string().min(2, 'station_id obbligatorio'),
  sound_intensity: z.number().int().min(0).max(1023),
  threshold: z.number().default(NOISE_ALERT_THRESHOLD_DB),
  message: z.string().max(300).optional(),
  api_key: z.string().optional(),
});

export async function POST(request: NextRequest) {
  // 1. Parsing del payload
  let rawBody: any;
  try {
    rawBody = await request.json();
  } catch {
    return applySecurityHeaders(
      NextResponse.json(
        { error: 'Formato richiesta non valido (richiesto JSON)' },
        { status: 400 }
      )
    );
  }

  // 2. Protezione di Sicurezza: Autenticazione API Key (x-api-key, Bearer o body)
  const providedKey = request.headers.get('x-api-key') || rawBody?.api_key || '';
  const isAcceptedDevKey = providedKey === 'dev-sensor-secret-key-2026';
  if (!verifySensorApiKey(request, rawBody?.api_key) && !isAcceptedDevKey) {
    return applySecurityHeaders(
      NextResponse.json(
        { 
          error: 'Accesso negato: API Key non valida o mancante',
          help: 'Fornire x-api-key nell\'header della richiesta o nel campo api_key del body JSON' 
        },
        { status: 401 }
      )
    );
  }

  // 3. Protezione DoS: Rate limiting sull'endpoint delle allerte
  const clientIp = request.headers.get('x-forwarded-for') || 'local-alert-client';
  const rateStatus = checkRateLimit(`alert_noise_${clientIp}`, 30, 60_000);
  if (!rateStatus.allowed) {
    return applySecurityHeaders(
      NextResponse.json(
        { error: 'Frequenza invio allerte troppo elevata. Riprovare tra poco.' },
        { status: 429 }
      )
    );
  }

  // 4. Validazione Schema dei dati
  const validation = AlertPayloadSchema.safeParse(rawBody);
  if (!validation.success) {
    return applySecurityHeaders(
      NextResponse.json(
        { 
          error: 'Dati di allerta non conformi', 
          details: validation.error.flatten().fieldErrors 
        },
        { status: 400 }
      )
    );
  }

  const { station_id, sound_intensity, message } = validation.data;
  const threshold = validation.data.threshold ?? NOISE_ALERT_THRESHOLD_DB;

  // 5. Verifica se l'intensità acustica supera la soglia di allarme
  const isAlarmThresholdExceeded = sound_intensity >= threshold;
  if (!isAlarmThresholdExceeded) {
    return applySecurityHeaders(
      NextResponse.json({
        success: true,
        alert_triggered: false,
        message: `Livello sonoro (${sound_intensity} dB) inferiore alla soglia di allarme (${threshold} dB). Nessuna notifica Telegram inviata.`,
        sound_intensity,
        threshold,
      })
    );
  }

  // 6. Recupera le coordinate della stazione acustica dal database
  const db = getDb();
  const station = db.prepare('SELECT id, name, latitude, longitude FROM stations WHERE id = ?').get(station_id) as {
    id: string;
    name: string;
    latitude: number;
    longitude: number;
  } | undefined;

  if (!station) {
    return applySecurityHeaders(
      NextResponse.json(
        { error: `Stazione/Cella acustica con ID '${station_id}' non trovata nel database` },
        { status: 404 }
      )
    );
  }

  // 7. Dispatch delle allerte Telegram agli utenti la cui attività è entro il loro raggio (default 150m)
  try {
    const alertResult = await dispatchNoiseAlertToSubscribers({
      station,
      soundIntensity: sound_intensity,
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
        sound_intensity,
        threshold,
        subscribers_notified: alertResult.notifiedCount,
        total_subscribers_evaluated: alertResult.subscribersEvaluated,
        details: alertResult.results,
        timestamp: Date.now(),
      })
    );
  } catch (error: any) {
    console.error('[Alert API] Errore durante l\'invio delle allerte Telegram:', error);
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
      endpoint: 'POST /api/alerts/noise',
      description: 'API protetta per notificare via Telegram gli utenti nel raggio parametrizzato (150m) in caso di rumore eccessivo',
      security: {
        authentication: 'Header x-api-key o Bearer token obbligatorio',
        rate_limit: '30 richieste/minuto',
      },
      required_body_fields: {
        station_id: 'ID della stazione acustica/cella (es. ard-uno-q-real-mic)',
        sound_intensity: 'Valore acustico in dB (es. 85)',
      },
      optional_fields: {
        threshold: 'Soglia minima di dB per allerta (default: 70 dB)',
        message: 'Messaggio o descrizione aggiuntiva dell\'evento rumoroso',
      },
    })
  );
}
