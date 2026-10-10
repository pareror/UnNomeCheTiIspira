import opening_hours from 'opening_hours';
import { isCompanyOpen } from '@/lib/google-maps';

// Canali con cui determinare se un esercizio è aperto in questo momento.
export type OpenStatusProvider = 'manual' | 'osm' | 'google' | 'off';

const PROVIDERS: OpenStatusProvider[] = ['manual', 'osm', 'google', 'off'];

export function getOpenStatusProvider(): OpenStatusProvider {
  const raw = (process.env.OPEN_STATUS_PROVIDER || 'manual').trim().toLowerCase();
  return (PROVIDERS as string[]).includes(raw) ? (raw as OpenStatusProvider) : 'manual';
}

/**
 * Destinatario valutabile: vale sia per un'azienda registrata (`Company`)
 * sia per un iscritto al bot (`TelegramSubscriber`).
 */
export interface OpenStatusTarget {
  name: string;
  latitude: number;
  longitude: number;
  google_place_id?: string | null;
  opening_hours?: string | null;
  osm_id?: string | null;
}

export interface OpenStatusResult {
  open: boolean | null; // true = aperto, false = chiuso, null = sconosciuto
  source: OpenStatusProvider;
}

/** Valuta un tag `opening_hours` (sintassi OSM) rispetto all'istante indicato. */
export function evaluateHoursTag(tag: string | null | undefined, at: Date = new Date()): boolean | null {
  if (!tag || !tag.trim()) return null;
  try {
    const oh = new opening_hours(tag);
    if (oh.getUnknown(at)) return null;
    return oh.getState(at);
  } catch {
    return null;
  }
}

// ---------- Provider "manual": orari registrati dall'esercente ----------
function fromManual(target: OpenStatusTarget): boolean | null {
  return evaluateHoursTag(target.opening_hours);
}

// ---------- Provider "osm": tag opening_hours via Overpass API ----------
const OVERPASS_ENDPOINT = process.env.OVERPASS_API_URL || 'https://overpass-api.de/api/interpreter';
const OVERPASS_CACHE_TTL_MS = 30 * 60 * 1000;
const osmHoursCache = new Map<string, { tag: string | null; expiresAt: number }>();

function buildOverpassQuery(target: OpenStatusTarget): string {
  if (target.osm_id) {
    const match = target.osm_id.match(/^(node|way|relation)\/(\d+)$/);
    if (match) {
      return `[out:json][timeout:10];${match[1]}(${match[2]});out tags;`;
    }
  }
  const name = target.name.replace(/["\\]/g, '').trim();
  return `[out:json][timeout:10];nwr(around:60,${target.latitude},${target.longitude})["name"="${name}"]["opening_hours"];out tags;`;
}

async function fetchOsmHours(target: OpenStatusTarget): Promise<string | null> {
  const cacheKey = target.osm_id || `${target.latitude},${target.longitude},${target.name}`;
  const cached = osmHoursCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.tag;

  let tag: string | null = null;
  try {
    const response = await fetch(OVERPASS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(buildOverpassQuery(target))}`,
    });

    if (!response.ok) {
      console.error('[open-status] Overpass API error:', response.status, response.statusText);
      return null;
    }

    const data = await response.json();
    const elements: any[] = Array.isArray(data?.elements) ? data.elements : [];
    const withHours = elements.filter((el) => el?.tags?.opening_hours);

    if (withHours.length === 1) {
      tag = withHours[0].tags.opening_hours;
    } else if (withHours.length > 1) {
      const exact = withHours.find(
        (el) => String(el?.tags?.name || '').toLowerCase() === target.name.toLowerCase()
      );
      tag = (exact || withHours[0]).tags.opening_hours;
    }
  } catch (error: any) {
    console.error('[open-status] Errore Overpass:', error?.message || error);
    return null;
  }

  osmHoursCache.set(cacheKey, { tag, expiresAt: Date.now() + OVERPASS_CACHE_TTL_MS });
  return tag;
}

async function fromOsm(target: OpenStatusTarget): Promise<boolean | null> {
  return evaluateHoursTag(await fetchOsmHours(target));
}

// ---------- Valutazione ----------
/**
 * Determina se il destinatario è aperto secondo il provider configurato.
 * `null` significa "sconosciuto": il chiamante decide se inviare comunque.
 */
export async function evaluateOpenStatus(target: OpenStatusTarget): Promise<OpenStatusResult> {
  const provider = getOpenStatusProvider();
  switch (provider) {
    case 'off':
      return { open: null, source: 'off' };
    case 'google':
      return { open: await isCompanyOpen(target.google_place_id), source: 'google' };
    case 'osm':
      return { open: await fromOsm(target), source: 'osm' };
    case 'manual':
    default:
      return { open: fromManual(target), source: 'manual' };
  }
}
