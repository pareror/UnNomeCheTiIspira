import Database from 'better-sqlite3';
import path from 'path';

// Singleton del database
let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!dbInstance) {
    const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'noise_monitor.db');
    dbInstance = new Database(dbPath);

    // Ottimizzazioni SQLite per scritture ad alta frequenza (~1Hz da più Arduino)
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('synchronous = NORMAL');

    initializeDatabase(dbInstance);
  }
  return dbInstance;
}

function initializeDatabase(db: Database.Database) {
  // Tabella Station: stazioni fisiche con flag is_dummy per oscuramento controllato
  db.exec(`
    CREATE TABLE IF NOT EXISTS stations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      is_dummy INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS noise_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id TEXT NOT NULL,
      sound_intensity INTEGER NOT NULL, -- unsigned int (dB o valore acustico campionario)
      timestamp INTEGER NOT NULL,        -- epoch timestamp in millisecondi
      FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_readings_station_time 
      ON noise_readings(station_id, timestamp DESC);
  `);

  // Migrazione retrocompatibile per colonna is_dummy se tabella preesistente
  try {
    db.exec(`ALTER TABLE stations ADD COLUMN is_dummy INTEGER NOT NULL DEFAULT 0;`);
  } catch {
    // La colonna esiste già
  }

  // Seleziona se ci sono stazioni registrate
  const count = db.prepare('SELECT count(*) as count FROM stations').get() as { count: number };
  if (count.count === 0) {
    seedInitialStations(db);
  } else {
    // Marca le stazioni generate come dummy per consentire l'oscuramento
    db.exec(`UPDATE stations SET is_dummy = 1 WHERE id LIKE 'ard-to-%';`);
  }
}

// Funzione conservata intatta per creare o ricreare dati dummy quando necessario
export function seedInitialStations(db?: Database.Database) {
  const database = db || getDb();
  const initialStations = [
    {
      id: 'ard-to-01',
      name: 'San Salvario (Via Baretti / Movida)',
      latitude: 45.0566,
      longitude: 7.6812,
      baseNoise: 78,
    },
    {
      id: 'ard-to-02',
      name: 'Piazza Santa Giulia (Vanchiglia)',
      latitude: 45.0673,
      longitude: 7.6961,
      baseNoise: 72,
    },
    {
      id: 'ard-to-03',
      name: 'Piazza Castello (Centro Storico)',
      latitude: 45.0709,
      longitude: 7.6861,
      baseNoise: 55,
    },
    {
      id: 'ard-to-04',
      name: 'Murazzi del Po (Lungo Fiume)',
      latitude: 45.0628,
      longitude: 7.6934,
      baseNoise: 88,
    },
    {
      id: 'ard-to-05',
      name: 'Porta Nuova (Piazza Carlo Felice)',
      latitude: 45.0621,
      longitude: 7.6789,
      baseNoise: 68,
    },
    {
      id: 'ard-to-06',
      name: 'Quadrilatero Romano (Via Bellezia)',
      latitude: 45.0747,
      longitude: 7.6804,
      baseNoise: 64,
    },
    {
      id: 'ard-to-07',
      name: 'Parco del Valentino (Area Verde Quieta)',
      latitude: 45.0531,
      longitude: 7.6854,
      baseNoise: 35,
    },
    {
      id: 'ard-to-08',
      name: 'Corso Francia / Piazza Statuto (Traffico)',
      latitude: 45.0768,
      longitude: 7.6681,
      baseNoise: 82,
    },
  ];

  const insertStation = database.prepare(`
    INSERT OR REPLACE INTO stations (id, name, latitude, longitude, is_dummy)
    VALUES (@id, @name, @latitude, @longitude, 1)
  `);

  const insertReading = database.prepare(`
    INSERT INTO noise_readings (station_id, sound_intensity, timestamp)
    VALUES (@station_id, @sound_intensity, @timestamp)
  `);

  const now = Date.now();
  const transaction = database.transaction(() => {
    for (const station of initialStations) {
      insertStation.run({
        id: station.id,
        name: station.name,
        latitude: station.latitude,
        longitude: station.longitude,
      });

      insertReading.run({
        station_id: station.id,
        sound_intensity: station.baseNoise,
        timestamp: now,
      });
    }
  });

  transaction();
}

// Interfacce Dati
export interface Station {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  is_dummy: number;
  created_at: string;
}

export interface NoiseReading {
  id: number;
  station_id: string;
  sound_intensity: number;
  timestamp: number;
}

export interface StationLiveStatus extends Station {
  current_intensity: number | null;
  last_reading_time: number | null;
}

// Inserimento nuova lettura dal sensore Arduino (is_dummy = 0 per hardware live reale)
export function insertNoiseReading(
  station_id: string, 
  sound_intensity: number, 
  timestamp?: number,
  stationMeta?: { name?: string; latitude?: number; longitude?: number; is_dummy?: boolean }
): NoiseReading {
  const db = getDb();
  const time = timestamp ?? Date.now();
  const isDummyVal = stationMeta?.is_dummy ? 1 : 0;

  // Verifica esistenza stazione: se non esiste ancora, auto-registrazione dinamica
  const stationExists = db.prepare('SELECT id FROM stations WHERE id = ?').get(station_id);
  if (!stationExists) {
    const name = stationMeta?.name || `Stazione Arduino (${station_id})`;
    // Coordinate fornite dal dispositivo o fallback su Torino centro
    const lat = stationMeta?.latitude ?? 45.0705;
    const lng = stationMeta?.longitude ?? 7.6868;

    db.prepare(`
      INSERT INTO stations (id, name, latitude, longitude, is_dummy)
      VALUES (?, ?, ?, ?, ?)
    `).run(station_id, name, lat, lng, isDummyVal);
  }

  const stmt = db.prepare(`
    INSERT INTO noise_readings (station_id, sound_intensity, timestamp)
    VALUES (?, ?, ?)
  `);

  const result = stmt.run(station_id, sound_intensity, time);
  return {
    id: Number(result.lastInsertRowid),
    station_id,
    sound_intensity,
    timestamp: time,
  };
}

// Recupera stazioni live con opzione di oscuramento/filtro per stazioni dummy
export function getStationsLive(filterMode: 'all' | 'live_only' | 'dummy_only' = 'all'): StationLiveStatus[] {
  const db = getDb();
  
  let whereClause = '';
  if (filterMode === 'live_only') {
    whereClause = 'WHERE s.is_dummy = 0';
  } else if (filterMode === 'dummy_only') {
    whereClause = 'WHERE s.is_dummy = 1';
  }

  const query = `
    SELECT 
      s.id,
      s.name,
      s.latitude,
      s.longitude,
      s.is_dummy,
      s.created_at,
      r.sound_intensity as current_intensity,
      r.timestamp as last_reading_time
    FROM stations s
    LEFT JOIN (
      SELECT station_id, sound_intensity, timestamp
      FROM (
        SELECT station_id, sound_intensity, timestamp,
               ROW_NUMBER() OVER (PARTITION BY station_id ORDER BY id DESC) as rn
        FROM noise_readings
      ) sub
      WHERE sub.rn = 1
    ) r ON s.id = r.station_id
    ${whereClause}
    ORDER BY s.is_dummy ASC, s.name ASC
  `;

  return db.prepare(query).all() as StationLiveStatus[];
}

// Recupera storico campionamenti per una specifica stazione (per backend / DB interno)
export function getStationHistory(station_id: string, limit: number = 100): NoiseReading[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT id, station_id, sound_intensity, timestamp
    FROM noise_readings
    WHERE station_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `);
  return stmt.all(station_id, limit) as NoiseReading[];
}

// Elenco stazioni pure
export function getAllStations(filterMode: 'all' | 'live_only' | 'dummy_only' = 'all'): Station[] {
  const db = getDb();
  let whereClause = '';
  if (filterMode === 'live_only') whereClause = 'WHERE is_dummy = 0';
  else if (filterMode === 'dummy_only') whereClause = 'WHERE is_dummy = 1';
  return db.prepare(`SELECT * FROM stations ${whereClause} ORDER BY name ASC`).all() as Station[];
}
