import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

// ==========================================
// 1. SCHEMI DI VALIDAZIONE RIGOROSA (ZOD)
// ==========================================

export const TelemetryReadingSchema = z.object({
  station_id: z
    .string()
    .min(2, 'station_id troppo breve')
    .max(64, 'station_id troppo lungo')
    .regex(/^[a-zA-Z0-9_-]+$/, 'station_id contiene caratteri non validi (consentiti solo alfanumerici, trattino e underscore)'),
  
  // Unsigned Int per l'intensità sonora (es. dB 0-150 oppure valore campionario ADC 0-1023)
  sound_intensity: z
    .number()
    .int('Il valore deve essere un numero intero')
    .nonnegative('Il valore deve essere un intero positivo (unsigned int)')
    .max(1023, 'Il valore supera il limite massimo consentito per i campionatori sonori'),

  // Timestamp opzionale fornito dall'Arduino slave (con fallback trasparente a Date.now() se non sincronizzato via NTP)
  timestamp: z
    .number()
    .int()
    .optional()
    .transform((ts) => {
      if (!ts) return Date.now();
      const now = Date.now();
      // Se l'orologio dell'Arduino è fuori sincronia (es. prima di NTP o avanti nel tempo), usa l'orario del server
      if (ts > now + 120_000 || ts < now - 86_400_000) {
        return now;
      }
      return ts;
    }),
  // Chiave API inclusa opzionalmente direttamente nel payload
  api_key: z.string().optional(),
});

export type TelemetryReadingInput = z.infer<typeof TelemetryReadingSchema>;

// Registrazione di un esercizio (esercente) destinatario delle allerte
export const CompanyRegistrationSchema = z.object({
  slug: z
    .string()
    .min(2, 'slug troppo breve')
    .max(64, 'slug troppo lungo')
    .regex(/^[a-z0-9-]+$/, 'slug: consentiti solo minuscole, numeri e trattini'),
  name: z.string().min(2, 'nome troppo breve').max(120, 'nome troppo lungo'),
  latitude: z.number().min(44.5).max(45.5),
  longitude: z.number().min(7.2).max(8.2),
  google_place_id: z.string().max(255).optional().nullable(),
  // Orari di apertura in sintassi OpenStreetMap, es. "Mo-Fr 18:00-02:00; Sa 19:00-03:00"
  opening_hours: z.string().max(255).optional().nullable(),
  // Riferimento all'elemento OpenStreetMap per recuperare gli orari, es. "node/123456"
  osm_id: z
    .string()
    .regex(/^(node|way|relation)\/\d+$/, 'osm_id deve essere nel formato node/123, way/123 o relation/123')
    .optional()
    .nullable(),
});

export type CompanyRegistrationInput = z.infer<typeof CompanyRegistrationSchema>;

// ==========================================
// 2. AUTENTICAZIONE TRAMITE API KEY
// ==========================================

export function verifySensorApiKey(request: NextRequest, bodyApiKey?: string): boolean {
  const configuredKey = process.env.SENSOR_API_KEY;
  if (!configuredKey) {
    return true;
  }

  // 1. Header x-api-key
  const apiKeyHeader = request.headers.get('x-api-key');
  if (apiKeyHeader && apiKeyHeader === configuredKey) {
    return true;
  }

  // 2. Header Authorization: Bearer <token>
  const authHeader = request.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    if (token === configuredKey) {
      return true;
    }
  }

  // 3. Query string (?api_key=... oppure ?key=...)
  const url = new URL(request.url);
  const queryKey = url.searchParams.get('api_key') || url.searchParams.get('key');
  if (queryKey && queryKey === configuredKey) {
    return true;
  }

  // 4. Chiave presente direttamente nel body JSON
  if (bodyApiKey && bodyApiKey === configuredKey) {
    return true;
  }

  return false;
}

export function verifyAdminApiKey(request: NextRequest): boolean {
  const configuredKey = process.env.ADMIN_API_KEY;
  if (!configuredKey) return true;

  const apiKeyHeader = request.headers.get('x-api-key') || request.headers.get('x-admin-key');
  const authHeader = request.headers.get('authorization');

  if (apiKeyHeader && apiKeyHeader === configuredKey) return true;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    if (token === configuredKey) return true;
  }

  return false;
}

// ==========================================
// 3. RATE LIMITER (ANTI-DOS / FLOODING)
// ==========================================

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

const rateLimitMap = new Map<string, RateLimitRecord>();

/**
 * Controlla se la richiesta rispetta la soglia di frequenza.
 * default: max 10 richieste ogni 5 secondi per chiave/IP (sufficiente per Arduino a 1Hz)
 */
export function checkRateLimit(
  identifier: string,
  maxRequests: number = 10,
  windowMs: number = 5000
): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const record = rateLimitMap.get(identifier);

  if (!record || now > record.resetTime) {
    rateLimitMap.set(identifier, {
      count: 1,
      resetTime: now + windowMs,
    });
    return { allowed: true, remaining: maxRequests - 1 };
  }

  if (record.count >= maxRequests) {
    return { allowed: false, remaining: 0 };
  }

  record.count += 1;
  return { allowed: true, remaining: maxRequests - record.count };
}

// ==========================================
// 4. HEADER DI SICUREZZA HTTP (OWASP)
// ==========================================

export function applySecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return response;
}
