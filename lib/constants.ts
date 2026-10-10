// Costanti di business logic per il monitoraggio acustico a Torino

// Raggio di copertura fisso per stazione acustica (15 metri come richiesto)
export const NOISE_RADIUS_METERS = 15;

// Raggio di allerta predefinito per le attività/utenti (parametrizzato e modificabile per utente, default 150 metri)
export const DEFAULT_ALERT_RADIUS_METERS = 150;

// Configurazione Bot Telegram per allerte acustiche (caricata da variabili d'ambiente)
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'NoiseTurin_bot';

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

// Soglia sonora oltre la quale scatta l'allerta (dB) - configurata a 70 dB come da richiesta utente
export const NOISE_ALERT_THRESHOLD_DB = 70;

// Durata minima di rumore elevato e continuativo prima di inviare l'allerta: 10 minuti
export const NOISE_ALERT_PERSISTENCE_MS = 10 * 60 * 1000;

// Tolleranza: una breve pausa sotto soglia (es. 1 minuto) non azzera una violazione in corso
export const NOISE_ALERT_QUIET_GRACE_MS = 60 * 1000;

// Intervallo minimo tra due allerte per la stessa violazione (anti-spam): 10 minuti
export const NOISE_ALERT_NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;

// Finestra temporale massima di validità dell'evento sonoro (2 minuti):
// Previene l'invio di allerte su dati storici o vecchi elaborati all'avvio del server
export const MAX_ALERT_EVENT_AGE_MS = 2 * 60 * 1000;

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

// Funzione di interpolazione lineare (LERP) per colori RGB
export function interpolateRgb(
  color1: [number, number, number], 
  color2: [number, number, number], 
  factor: number
): string {
  const f = Math.max(0, Math.min(1, factor));
  const r = Math.round(color1[0] + (color2[0] - color1[0]) * f);
  const g = Math.round(color1[1] + (color2[1] - color1[1]) * f);
  const b = Math.round(color1[2] + (color2[2] - color1[2]) * f);
  return `rgb(${r}, ${g}, ${b})`;
}

// Restituisce un colore continuo, graduale e privo di scatti repentini in base ai decibel reali
export function getSmoothNoiseColor(intensity: number): string {
  if (intensity <= 38) {
    return 'rgb(241, 245, 249)'; // Bianco / Grigio ghiaccio (< 40 dB)
  } else if (intensity <= 60) {
    // Transizione graduale da Bianco a Verde
    const f = (intensity - 38) / (60 - 38);
    return interpolateRgb([241, 245, 249], [34, 197, 94], f);
  } else if (intensity <= 75) {
    // Transizione graduale da Verde a Giallo ambra
    const f = (intensity - 60) / (75 - 60);
    return interpolateRgb([34, 197, 94], [234, 179, 8], f);
  } else if (intensity <= 90) {
    // Transizione graduale da Giallo a Rosso fuoco
    const f = (intensity - 75) / (90 - 75);
    return interpolateRgb([234, 179, 8], [255, 23, 68], f);
  } else {
    // Transizione graduale da Rosso fuoco a Viola fluorescente
    const f = Math.min(1, (intensity - 90) / 20);
    return interpolateRgb([255, 23, 68], [213, 0, 249], f);
  }
}

