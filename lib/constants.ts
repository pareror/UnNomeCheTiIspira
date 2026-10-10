// Costanti di business logic per il monitoraggio acustico a Torino

// Raggio di copertura fisso per stazione acustica (15 metri come richiesto)
export const NOISE_RADIUS_METERS = 15;

// Coordinate centrali della città di Torino e livello di zoom consigliato
export const TURIN_CENTER: [number, number] = [45.0683, 7.6830]; // [lat, lng]
export const TURIN_CENTER_LNG_LAT: [number, number] = [7.6830, 45.0683]; // [lng, lat] per MapLibre
export const TURIN_DEFAULT_ZOOM = 13.5;

// Bounding Box del Comune di Torino per ritagliare la visualizzazione:
// [minLng, minLat], [maxLng, maxLat]
export const TURIN_BOUNDS_MAPLIBRE: [[number, number], [number, number]] = [
  [7.580, 45.002], // Sud-Ovest (Moncalieri / Grugliasco)
  [7.770, 45.142], // Nord-Est (Settimo Torinese / San Mauro)
];

// Stili OpenFreeMap gratuiti senza API key (https://openfreemap.org/)
export const OPENFREEMAP_STYLES = {
  liberty: 'https://tiles.openfreemap.org/styles/liberty',
  positron: 'https://tiles.openfreemap.org/styles/positron',
  bright: 'https://tiles.openfreemap.org/styles/bright',
} as const;

export type OpenFreeMapStyleKey = keyof typeof OPENFREEMAP_STYLES;

// Frequenza di auto-refresh del frontend per la mappa: 1 minuto (60 secondi)
export const FRONTEND_REFRESH_INTERVAL_MS = 60 * 1000;

// ==========================================
// ALLERTA RUMORE PERSISTENTE (ESERCENTI)
// ==========================================

// Soglia sonora oltre la quale una lettura è considerata "volume elevato" (dB).
// Valori > 65 dB corrispondono alle bande "Medio", "Forte" e "Critico" (vedi getNoiseLevel).
export const NOISE_ALERT_THRESHOLD_DB = 65;

// Durata minima di rumore elevato e continuativo prima di inviare l'allerta: 10 minuti
export const NOISE_ALERT_PERSISTENCE_MS = 10 * 60 * 1000;

// Tolleranza: una breve pausa sotto soglia (es. 1 minuto) non azzera una violazione in corso
export const NOISE_ALERT_QUIET_GRACE_MS = 60 * 1000;

// Intervallo minimo tra due allerte per la stessa violazione (anti-spam): 10 minuti
export const NOISE_ALERT_NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;

// Raggio attorno alla stazione entro cui gli esercenti sono considerati "limitrofi" e allertati
export const COMPANY_ALERT_RADIUS_METERS = 200;

// Scala cromatica del rumore secondo le specifiche:
// - Poco o nessun rumore: Bianco
// - Rumore lieve: Verde
// - Rumore medio: Giallo
// - Rumore forte / intenso: Rosso / Viola
export interface NoiseLevelInfo {
  level: 'quiet' | 'low' | 'medium' | 'high' | 'critical';
  color: string;
  fillColor: string;
  fillOpacity: number;
  label: string;
  description: string;
}

export function getNoiseLevel(intensity: number): NoiseLevelInfo {
  if (intensity < 40) {
    return {
      level: 'quiet',
      color: '#cbd5e1',
      fillColor: '#ffffff',
      fillOpacity: 0.85,
      label: 'Assente / Basso',
      description: 'Poco o nessun rumore (< 40 dB)',
    };
  } else if (intensity <= 65) {
    return {
      level: 'low',
      color: '#16a34a',
      fillColor: '#22c55e',
      fillOpacity: 0.75,
      label: 'Lieve',
      description: 'Rumore lieve (40 - 65 dB)',
    };
  } else if (intensity <= 80) {
    return {
      level: 'medium',
      color: '#ca8a04',
      fillColor: '#eab308',
      fillOpacity: 0.8,
      label: 'Medio',
      description: 'Rumore medio (66 - 80 dB)',
    };
  } else if (intensity <= 95) {
    return {
      level: 'high',
      color: '#dc2626',
      fillColor: '#ff1744', // Rosso neon vivido ed evidente
      fillOpacity: 0.95,
      label: 'Forte / Allarme',
      description: 'Rumore forte (81 - 95 dB)',
    };
  } else {
    return {
      level: 'critical',
      color: '#9333ea',
      fillColor: '#d500f9', // Viola / Magenta fluorescente ad altissimo impatto visivo
      fillOpacity: 1.0,
      label: 'Intenso / Critico',
      description: 'Rumore critico (> 95 dB)',
    };
  }
}
