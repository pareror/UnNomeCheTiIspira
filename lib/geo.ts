// Modulo per calcoli geodetici ad alta precisione e geocodifica indirizzi a Torino

export interface GeocodedAddress {
  latitude: number;
  longitude: number;
  formattedAddress: string;
}

export interface NearbyStationMatch<T = any> {
  station: T;
  distanceMeters: number;
}

/**
 * Calcola la distanza geodetica ortodromica in metri tra due coordinate geografiche
 * utilizzando la formula dell'Emisenoverso (Haversine Formula) ad alta precisione.
 */
export function calculateHaversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Raggio medio terrestre in metri
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10; // Precisione al decimetro
}

/**
 * Filtra e ordina le stazioni/celle presenti entro un raggio specificato (in metri).
 */
export function findStationsWithinRadius<T extends { latitude: number; longitude: number }>(
  centerLat: number,
  centerLon: number,
  radiusMeters: number,
  stations: T[]
): NearbyStationMatch<T>[] {
  const matches: NearbyStationMatch<T>[] = [];

  for (const station of stations) {
    const dist = calculateHaversineDistanceMeters(
      centerLat,
      centerLon,
      station.latitude,
      station.longitude
    );

    if (dist <= radiusMeters) {
      matches.push({
        station,
        distanceMeters: dist,
      });
    }
  }

  // Ordina per distanza crescente (dalla più vicina alla più lontana)
  return matches.sort((a, b) => a.distanceMeters - b.distanceMeters);
}

/**
 * Mappatura euristica di sicurezza per le vie e piazze iconiche di Torino,
 * utilizzata in caso di mancata risposta o timeout del servizio OpenStreetMap Nominatim.
 */
const TURIN_KNOWN_STREETS_COORDS: Record<string, { lat: number; lon: number; name: string }> = {
  'via po': { lat: 45.0688, lon: 7.6888, name: 'Via Po, Centro, Torino' },
  'via roma': { lat: 45.0667, lon: 7.6828, name: 'Via Roma, Centro, Torino' },
  'piazza castello': { lat: 45.0709, lon: 7.6861, name: 'Piazza Castello, Centro, Torino' },
  'piazza san carlo': { lat: 45.0677, lon: 7.6830, name: 'Piazza San Carlo, Centro, Torino' },
  'piazza vittorio': { lat: 45.0645, lon: 7.6953, name: 'Piazza Vittorio Veneto, Torino' },
  'piazza vittorio veneto': { lat: 45.0645, lon: 7.6953, name: 'Piazza Vittorio Veneto, Torino' },
  'via garibaldi': { lat: 45.0734, lon: 7.6806, name: 'Via Giuseppe Garibaldi, Centro, Torino' },
  'via baretti': { lat: 45.0569, lon: 7.6812, name: 'Via Baretti, San Salvario, Torino' },
  'piazza santa giulia': { lat: 45.0673, lon: 7.6961, name: 'Piazza Santa Giulia, Vanchiglia, Torino' },
  'corso francia': { lat: 45.0768, lon: 7.6681, name: 'Corso Francia, Torino' },
  'porta nuova': { lat: 45.0621, lon: 7.6789, name: 'Piazza Carlo Felice / Stazione Porta Nuova, Torino' },
  'murazzi': { lat: 45.0628, lon: 7.6934, name: 'Murazzi del Po, Torino' },
  'via nizza': { lat: 45.0500, lon: 7.6740, name: 'Via Nizza, Torino' },
  'quadrilatero': { lat: 45.0747, lon: 7.6804, name: 'Quadrilatero Romano, Torino' },
};

/**
 * Esegue la geocodifica di un indirizzo torinese (via + civico) tramite OpenStreetMap Nominatim
 * con fallback euristico sul Comune di Torino.
 */
export async function geocodeAddressTurin(address: string): Promise<GeocodedAddress | null> {
  const cleanAddr = address.trim();
  if (!cleanAddr) return null;

  // Prepara query esplicita vincolata a Torino, Italia
  let query = cleanAddr;
  if (!query.toLowerCase().includes('torino')) {
    query = `${query}, Torino, Italia`;
  }

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
      query
    )}&countrycodes=it`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'TorinoNoiseMonitor/1.0 (telemetry-bot@antigravity.local)',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        return {
          latitude: parseFloat(data[0].lat),
          longitude: parseFloat(data[0].lon),
          formattedAddress: data[0].display_name,
        };
      }
    }
  } catch (err) {
    console.warn(`[GEO] Nominatim non raggiungibile per '${cleanAddr}', ricorso a euristica:`, err);
  }

  // Fallback euristico sulle coordinate note di Torino
  const lower = cleanAddr.toLowerCase();
  for (const [key, val] of Object.entries(TURIN_KNOWN_STREETS_COORDS)) {
    if (lower.includes(key)) {
      return {
        latitude: val.lat,
        longitude: val.lon,
        formattedAddress: `${cleanAddr} (${val.name})`,
      };
    }
  }

  // Fallback estremo su Torino Centro
  return {
    latitude: 45.0705,
    longitude: 7.6868,
    formattedAddress: `${cleanAddr}, Torino (Coordinate approssimate centro)`,
  };
}
