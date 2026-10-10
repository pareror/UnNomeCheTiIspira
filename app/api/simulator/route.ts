import { NextResponse } from 'next/server';
import { getAllStations, insertNoiseReading } from '@/lib/db';
import { processReadingForAlerts } from '@/lib/alerts';
import { applySecurityHeaders } from '@/lib/security';

// Genera variazioni realistiche per le stazioni di Torino
function generateSimulatedIntensity(stationId: string): number {
  const baseNoiseByStation: Record<string, { min: number; max: number; burstChance: number }> = {
    'ard-to-01': { min: 65, max: 88, burstChance: 0.25 }, // San Salvario (Movida)
    'ard-to-02': { min: 58, max: 79, burstChance: 0.15 }, // Vanchiglia
    'ard-to-03': { min: 45, max: 68, burstChance: 0.05 }, // Piazza Castello
    'ard-to-04': { min: 70, max: 96, burstChance: 0.30 }, // Murazzi del Po
    'ard-to-05': { min: 60, max: 82, burstChance: 0.10 }, // Porta Nuova
    'ard-to-06': { min: 50, max: 72, burstChance: 0.10 }, // Quadrilatero
    'ard-to-07': { min: 25, max: 42, burstChance: 0.02 }, // Parco Valentino (Quieto)
    'ard-to-08': { min: 68, max: 89, burstChance: 0.20 }, // Corso Francia / Statuto
  };

  const profile = baseNoiseByStation[stationId] || { min: 40, max: 75, burstChance: 0.1 };
  
  // Picco improvviso simulato (es. sirena, grido, accelerata)
  if (Math.random() < profile.burstChance) {
    return Math.floor(Math.min(115, profile.max + Math.random() * 20));
  }

  const range = profile.max - profile.min;
  return Math.floor(profile.min + Math.random() * range);
}

// POST: simula un ciclo di acquisizione da parte di tutti i sensori Arduino slave
export async function POST() {
  try {
    const stations = getAllStations();
    const now = Date.now();
    const newReadings = [];

    let alertsTriggered = 0;
    for (const station of stations) {
      const intensity = generateSimulatedIntensity(station.id);
      const reading = insertNoiseReading(station.id, intensity, now);
      const alertResult = await processReadingForAlerts(station.id, intensity, reading.timestamp);
      if (alertResult.alerted) alertsTriggered += 1;
      newReadings.push({
        station_id: station.id,
        name: station.name,
        sound_intensity: intensity,
        timestamp: now,
      });
    }

    return applySecurityHeaders(
      NextResponse.json({
        success: true,
        message: `Simulazione completata con successo per ${stations.length} stazioni slave`,
        alerts_triggered: alertsTriggered,
        readings_generated: newReadings,
      })
    );
  } catch (error: any) {
    return applySecurityHeaders(
      NextResponse.json({ error: error.message }, { status: 500 })
    );
  }
}
