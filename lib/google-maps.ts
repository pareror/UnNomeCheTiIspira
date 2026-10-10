// Integrazione con Google Maps Platform (Places API v1) per verificare
// se un esercizio è attualmente aperto. Senza API key il check è "sconosciuto".

const PLACES_API_BASE = 'https://places.googleapis.com/v1/places';
const OPEN_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  open: boolean | null;
  expiresAt: number;
}

const openStatusCache = new Map<string, CacheEntry>();
let missingKeyWarned = false;

/** Distanza in metri fra due coordinate geografiche (formula dell'emisenoverso). */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000; // raggio medio terrestre in metri
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Verifica se l'esercizio è attualmente aperto secondo Google Maps.
 * Restituisce:
 *  - true/false se Google risponde in modo affidabile;
 *  - null se lo stato è sconosciuto (nessuna API key, nessun place_id, errore di rete).
 * Il chiamante decide come trattare il valore null.
 */
export async function isCompanyOpen(placeId: string | null | undefined): Promise<boolean | null> {
  if (!placeId) return null;

  const cached = openStatusCache.get(placeId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.open;
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    if (!missingKeyWarned) {
      console.warn('[google-maps] GOOGLE_MAPS_API_KEY non configurata: stato "aperto" non verificabile');
      missingKeyWarned = true;
    }
    openStatusCache.set(placeId, { open: null, expiresAt: Date.now() + OPEN_STATUS_CACHE_TTL_MS });
    return null;
  }

  try {
    const response = await fetch(`${PLACES_API_BASE}/${encodeURIComponent(placeId)}`, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'regularOpeningHours.openNow,currentOpeningHours.openNow',
      },
    });

    if (!response.ok) {
      console.error('[google-maps] Places API error:', response.status, response.statusText);
      return null;
    }

    const data = await response.json();
    const open =
      data?.currentOpeningHours?.openNow ??
      data?.regularOpeningHours?.openNow ??
      null;

    openStatusCache.set(placeId, { open, expiresAt: Date.now() + OPEN_STATUS_CACHE_TTL_MS });
    return open;
  } catch (error: any) {
    console.error('[google-maps] Errore di rete:', error.message);
    return null;
  }
}
