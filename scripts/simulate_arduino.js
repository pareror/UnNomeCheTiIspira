/**
 * Script di simulazione hardware Arduino Slave
 * Simula l'invio via rete HTTP POST con autenticazione x-api-key
 * a frequenza di circa 1 secondo (~1Hz) verso il server Master Next.js.
 */

const API_URL = process.env.API_URL || 'http://localhost:3000/api/telemetry/reading';
const API_KEY = process.env.SENSOR_API_KEY || 'arduino-torino-noise-secret-2026';

const STATIONS = [
  { id: 'ard-to-01', name: 'San Salvario', min: 65, max: 90 },
  { id: 'ard-to-02', name: 'Vanchiglia / S. Giulia', min: 58, max: 80 },
  { id: 'ard-to-03', name: 'Piazza Castello', min: 45, max: 68 },
  { id: 'ard-to-04', name: 'Murazzi del Po', min: 72, max: 98 },
  { id: 'ard-to-05', name: 'Porta Nuova', min: 60, max: 82 },
  { id: 'ard-to-06', name: 'Quadrilatero', min: 50, max: 74 },
  { id: 'ard-to-07', name: 'Parco del Valentino', min: 28, max: 42 },
  { id: 'ard-to-08', name: 'Piazza Statuto', min: 68, max: 92 },
];

console.log('========================================================');
console.log(' AVVIO SIMULATORE ARDUINO SLAVE (Frequenza ~1 secondo)');
console.log(` Target Server Master: ${API_URL}`);
console.log(` Stazioni attive in simulazione: ${STATIONS.length}`);
console.log('========================================================');

async function sendReading(station) {
  // Calcolo valore con fluttuazione realistica
  const base = station.min + Math.random() * (station.max - station.min);
  const burst = Math.random() < 0.15 ? Math.random() * 20 : 0;
  const soundIntensity = Math.min(115, Math.floor(base + burst));

  const payload = {
    station_id: station.id,
    sound_intensity: soundIntensity, // unsigned int
    timestamp: Date.now(),
  };

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      console.log(`[OK ${new Date().toLocaleTimeString()}] ${station.id} (${station.name}): ${soundIntensity} dB registrati.`);
    } else {
      const err = await res.text();
      console.error(`[ERR] ${station.id} -> HTTP ${res.status}: ${err}`);
    }
  } catch (err) {
    console.error(`[CONN ERROR] Impossibile raggiungere il server (${err.message})`);
  }
}

// Ciclo di campionamento a ~1Hz
setInterval(() => {
  for (const station of STATIONS) {
    sendReading(station);
  }
}, 1000);
