import { NextRequest, NextResponse } from 'next/server';
import { 
  verifySensorApiKey, 
  TelemetryReadingSchema, 
  checkRateLimit, 
  applySecurityHeaders 
} from '@/lib/security';
import { insertNoiseReading, getStationById } from '@/lib/db';
import { processReadingForAlerts } from '@/lib/alerts';
import { dispatchNoiseAlertToSubscribers } from '@/lib/telegram';
import { NOISE_ALERT_THRESHOLD_DB, NOISE_ALERT_NOTIFY_COOLDOWN_MS } from '@/lib/constants';

async function parseIncomingPayload(request: NextRequest): Promise<any> {
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      return await request.json();
    } catch {
      return null;
    }
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    try {
      const formData = await request.formData();
      const obj: Record<string, any> = {};
      formData.forEach((value, key) => {
        if (key === 'sound_intensity' || key === 'timestamp' || key === 'latitude' || key === 'longitude') {
          obj[key] = Number(value);
        } else {
          obj[key] = value;
        }
      });
      return obj;
    } catch {
      return null;
    }
  }

  // Fallback: prova JSON o query string
  try {
    return await request.json();
  } catch {
    const url = new URL(request.url);
    const station_id = url.searchParams.get('station_id');
    const sound_intensity = url.searchParams.get('sound_intensity');
    if (station_id && sound_intensity) {
      return {
        station_id,
        sound_intensity: Number(sound_intensity),
        timestamp: url.searchParams.get('timestamp') ? Number(url.searchParams.get('timestamp')) : undefined,
        api_key: url.searchParams.get('api_key') || url.searchParams.get('key'),
      };
    }
    return null;
  }
}

export async function POST(request: NextRequest) {
  // 1. Estrazione dati dal payload
  const rawBody = await parseIncomingPayload(request);
  if (!rawBody) {
    return applySecurityHeaders(
      NextResponse.json(
        { error: 'Corpo della richiesta mancante o formato non supportato (usare JSON o Form URL-Encoded)' },
        { status: 400 }
      )
    );
  }

  // 2. Autenticazione Sensore (Header x-api-key, Bearer token, query param o chiave nel body)
  if (!verifySensorApiKey(request, rawBody.api_key)) {
    return applySecurityHeaders(
      NextResponse.json(
        { 
          error: 'Autenticazione rifiutata: API Key sensore mancante o errata',
          help: 'Invia x-api-key nell\'header, come bearer token o nel campo "api_key" del body JSON',
        },
        { status: 401 }
      )
    );
  }

  // 3. Protezione DoS / Flooding tramite Rate Limiter
  const clientIp = request.headers.get('x-forwarded-for') || 'local-client';
  const rateLimitStatus = checkRateLimit(`telemetry_${clientIp}`, 25, 5000);
  if (!rateLimitStatus.allowed) {
    return applySecurityHeaders(
      NextResponse.json(
        { error: 'Rate limit superato: frequenza di invio troppo elevata' },
        { status: 429 }
      )
    );
  }

  // 4. Validazione Rigorosa del Payload (Zod)
  const validation = TelemetryReadingSchema.safeParse(rawBody);
  if (!validation.success) {
    return applySecurityHeaders(
      NextResponse.json(
        {
          error: 'Dati di telemetria non conformi alle specifiche',
          details: validation.error.flatten().fieldErrors,
        },
        { status: 400 }
      )
    );
  }

  const { station_id, sound_intensity, timestamp, name, latitude, longitude } = validation.data;

  // 5. Inserimento nel database SQLite (con auto-registrazione per nuove schede Arduino WiFi)
  try {
    const reading = insertNoiseReading(station_id, sound_intensity, timestamp, {
      name,
      latitude,
      longitude,
    });

    // 6. Notifica tempestiva via Telegram per gli iscritti nel raggio dell'attività
    // Soglia: sound_intensity >= 70 dB | Cooldown anti-spam: 10 minuti (600.000 ms)
    let telegramSubscribersNotified = 0;
    if (sound_intensity >= NOISE_ALERT_THRESHOLD_DB) {
      const station = getStationById(station_id);
      if (station) {
        try {
          const subResult = await dispatchNoiseAlertToSubscribers({
            station: {
              id: station.id,
              name: station.name,
              latitude: station.latitude,
              longitude: station.longitude,
            },
            soundIntensity: sound_intensity,
            customMessage: 'Rilevamento acustico in tempo reale dal sensore della stazione',
            cooldownMs: NOISE_ALERT_NOTIFY_COOLDOWN_MS,
          });
          telegramSubscribersNotified = subResult.notifiedCount;
        } catch (err: any) {
          console.error('[Telemetry] Errore dispatch allerta Telegram iscritti:', err);
        }
      }
    }

    // 7. Valutazione della soglia di rumore persistente e invio allerte esercenti
    const alertResult = await processReadingForAlerts(station_id, sound_intensity, reading.timestamp);

    return applySecurityHeaders(
      NextResponse.json(
        {
          success: true,
          message: 'Dato registrato con successo nel database in tempo reale',
          data: reading,
          alert_triggered: alertResult.alerted || telegramSubscribersNotified > 0,
          telegram_subscribers_notified: telegramSubscribersNotified,
        },
        { status: 201 }
      )
    );
  } catch (error: any) {
    return applySecurityHeaders(
      NextResponse.json(
        { error: error.message || 'Errore durante la registrazione nel database' },
        { status: 500 }
      )
    );
  }
}

// Supporto anche per GET per microcontrollori semplici con limitazioni HTTP
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const station_id = url.searchParams.get('station_id');
  const sound_intensity_str = url.searchParams.get('sound_intensity');

  if (!station_id || !sound_intensity_str) {
    return applySecurityHeaders(
      NextResponse.json({
        endpoint: 'POST /api/telemetry/reading',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'arduino-torino-noise-secret-2026',
        },
        example_payload: {
          station_id: 'ard-to-01',
          sound_intensity: 75,
          timestamp: Date.now(),
        },
      })
    );
  }

  // Se i parametri sono presenti nella query string di GET, trattalo come telemetria
  return POST(request);
}

// Opzioni CORS preflight per chiamate da qualunque client/browser
export async function OPTIONS() {
  const response = new NextResponse(null, { status: 204 });
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
  return applySecurityHeaders(response);
}
