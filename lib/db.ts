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

    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      telegram_chat_id TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      google_place_id TEXT,
      opening_hours TEXT,
      osm_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS noise_breaches (
      station_id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      last_high_at INTEGER NOT NULL,
      quiet_since INTEGER,
      notified_at INTEGER,
      alert_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS noise_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id TEXT NOT NULL,
      threshold_db INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      triggered_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      recipients INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'sent',
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_noise_alerts_time
      ON noise_alerts(triggered_at DESC);

    CREATE TABLE IF NOT EXISTS bot_auth_keys (
      auth_key TEXT PRIMARY KEY,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS telegram_subscribers (
      chat_id TEXT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      auth_key TEXT,
      is_authenticated INTEGER NOT NULL DEFAULT 0,
      address TEXT,
      latitude REAL,
      longitude REAL,
      alert_radius_meters INTEGER NOT NULL DEFAULT 150,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_alert_at INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Seeding chiavi autorizzazione per il bot Telegram
  try {
    const keyCount = db.prepare('SELECT count(*) as count FROM bot_auth_keys').get() as { count: number };
    if (keyCount.count === 0) {
      const insertKey = db.prepare('INSERT OR IGNORE INTO bot_auth_keys (auth_key, description) VALUES (?, ?)');
      insertKey.run('TORINO-ALERT-KEY-2026', 'Master Key Torino Allerte 2026');
      insertKey.run('BAR-SAN-SALVARIO-01', 'Esercente San Salvario');
      insertKey.run('COMMERCIO-VIA-PO-14', 'Esercente Via Po');
    }
  } catch (err) {
    console.warn('[DB] Inizializzazione chiavi bot:', err);
  }

  // Migrazione retrocompatibile per colonna is_dummy se tabella preesistente
  try {
    db.exec(`ALTER TABLE stations ADD COLUMN is_dummy INTEGER NOT NULL DEFAULT 0;`);
  } catch {
    // La colonna esiste già
  }

  // Migrazioni retrocompatibili per le colonne orari di apertura degli esercizi
  try {
    db.exec(`ALTER TABLE companies ADD COLUMN opening_hours TEXT;`);
  } catch {
    // La colonna esiste già
  }
  try {
    db.exec(`ALTER TABLE companies ADD COLUMN osm_id TEXT;`);
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

export interface Company {
  id: number;
  slug: string;
  name: string;
  telegram_chat_id: string | null;
  latitude: number;
  longitude: number;
  google_place_id: string | null;
  opening_hours: string | null;
  osm_id: string | null;
  created_at: string;
}

export interface NoiseBreach {
  station_id: string;
  started_at: number;
  last_high_at: number;
  quiet_since: number | null;
  notified_at: number | null;
  alert_count: number;
}

export interface NoiseAlert {
  id: number;
  station_id: string;
  threshold_db: number;
  started_at: number;
  triggered_at: number;
  duration_ms: number;
  recipients: number;
  status: string;
  details: string | null;
  created_at: string;
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
  let station = db.prepare('SELECT id, name, latitude, longitude, is_dummy FROM stations WHERE id = ?').get(station_id) as any;
  if (!station) {
    const name = stationMeta?.name || `Stazione Arduino (${station_id})`;
    // Coordinate fornite dal dispositivo o fallback su Torino centro
    const lat = stationMeta?.latitude ?? 45.0705;
    const lng = stationMeta?.longitude ?? 7.6868;

    db.prepare(`
      INSERT INTO stations (id, name, latitude, longitude, is_dummy)
      VALUES (?, ?, ?, ?, ?)
    `).run(station_id, name, lat, lng, isDummyVal);

    station = {
      id: station_id,
      name,
      latitude: lat,
      longitude: lng,
      is_dummy: isDummyVal,
    };
  }

  const stmt = db.prepare(`
    INSERT INTO noise_readings (station_id, sound_intensity, timestamp)
    VALUES (?, ?, ?)
  `);

  const result = stmt.run(station_id, sound_intensity, time);

  // Emetti evento real-time per lo stream Just-in-Time
  try {
    const { telemetryEmitter } = require('./events');
    telemetryEmitter.emit('reading', {
      id: station.id,
      name: station.name,
      latitude: station.latitude,
      longitude: station.longitude,
      is_dummy: Boolean(station.is_dummy),
      current_intensity: sound_intensity,
      last_reading_time: time,
      radius_meters: 15,
    });
  } catch (err) {
    console.error('Errore durante l\'emissione evento stream:', err);
  }

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

export function getStationById(stationId: string): Station | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId) as Station | undefined;
}

// ==========================================
// ANAGRAFICA AZIENDE (ESERCENTI) + TELEGRAM
// ==========================================

export function upsertCompany(input: {
  slug: string;
  name: string;
  latitude: number;
  longitude: number;
  google_place_id?: string | null;
  opening_hours?: string | null;
  osm_id?: string | null;
}): Company {
  const db = getDb();
  db.prepare(`
    INSERT INTO companies (slug, name, latitude, longitude, google_place_id, opening_hours, osm_id)
    VALUES (@slug, @name, @latitude, @longitude, @google_place_id, @opening_hours, @osm_id)
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      google_place_id = excluded.google_place_id,
      opening_hours = excluded.opening_hours,
      osm_id = excluded.osm_id
  `).run({
    slug: input.slug,
    name: input.name,
    latitude: input.latitude,
    longitude: input.longitude,
    google_place_id: input.google_place_id ?? null,
    opening_hours: input.opening_hours ?? null,
    osm_id: input.osm_id ?? null,
  });
  return getCompanyBySlug(input.slug)!;
}

export function getCompanyBySlug(slug: string): Company | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM companies WHERE slug = ?').get(slug) as Company | undefined;
}

export function listCompanies(): Company[] {
  const db = getDb();
  return db.prepare('SELECT * FROM companies ORDER BY name ASC').all() as Company[];
}

export function getCompaniesWithTelegram(): Company[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM companies WHERE telegram_chat_id IS NOT NULL AND telegram_chat_id != '' ORDER BY name ASC")
    .all() as Company[];
}

export function linkTelegramChat(slug: string, chatId: string): Company | undefined {
  const db = getDb();
  const company = getCompanyBySlug(slug);
  if (!company) return undefined;
  db.prepare('UPDATE companies SET telegram_chat_id = ? WHERE slug = ?').run(chatId, slug);
  return getCompanyBySlug(slug);
}

export function unlinkTelegramChat(chatId: string): number {
  const db = getDb();
  const result = db.prepare('UPDATE companies SET telegram_chat_id = NULL WHERE telegram_chat_id = ?').run(chatId);
  return result.changes;
}

export function getCompaniesByChatId(chatId: string): Company[] {
  const db = getDb();
  return db.prepare('SELECT * FROM companies WHERE telegram_chat_id = ? ORDER BY name ASC').all(chatId) as Company[];
}

// ==========================================
// STATO DELLE SOGLIE DI RUMORE (BREACH) E ALERT
// ==========================================

export function getNoiseBreach(stationId: string): NoiseBreach | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM noise_breaches WHERE station_id = ?').get(stationId) as NoiseBreach | undefined;
}

export function upsertNoiseBreach(breach: NoiseBreach): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO noise_breaches (station_id, started_at, last_high_at, quiet_since, notified_at, alert_count)
    VALUES (@station_id, @started_at, @last_high_at, @quiet_since, @notified_at, @alert_count)
    ON CONFLICT(station_id) DO UPDATE SET
      started_at = excluded.started_at,
      last_high_at = excluded.last_high_at,
      quiet_since = excluded.quiet_since,
      notified_at = excluded.notified_at,
      alert_count = excluded.alert_count
  `).run(breach);
}

export function deleteNoiseBreach(stationId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM noise_breaches WHERE station_id = ?').run(stationId);
}

export function getActiveBreaches(): NoiseBreach[] {
  const db = getDb();
  return db.prepare('SELECT * FROM noise_breaches ORDER BY started_at ASC').all() as NoiseBreach[];
}

export function insertNoiseAlert(input: {
  station_id: string;
  threshold_db: number;
  started_at: number;
  triggered_at: number;
  duration_ms: number;
  recipients: number;
  status: string;
  details?: string | null;
}): NoiseAlert {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO noise_alerts (station_id, threshold_db, started_at, triggered_at, duration_ms, recipients, status, details)
    VALUES (@station_id, @threshold_db, @started_at, @triggered_at, @duration_ms, @recipients, @status, @details)
  `).run({
    station_id: input.station_id,
    threshold_db: input.threshold_db,
    started_at: input.started_at,
    triggered_at: input.triggered_at,
    duration_ms: input.duration_ms,
    recipients: input.recipients,
    status: input.status,
    details: input.details ?? null,
  });
  return db.prepare('SELECT * FROM noise_alerts WHERE id = ?').get(Number(result.lastInsertRowid)) as NoiseAlert;
}

export function getRecentAlerts(limit: number = 50): NoiseAlert[] {
  const db = getDb();
  return db.prepare('SELECT * FROM noise_alerts ORDER BY triggered_at DESC LIMIT ?').all(limit) as NoiseAlert[];
}

// ==========================================
// UTENTI ED ISCRITTI TELEGRAM BOT (AREA 150M)
// ==========================================

export interface TelegramSubscriber {
  chat_id: string;
  username: string | null;
  first_name: string | null;
  auth_key: string | null;
  is_authenticated: number;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  alert_radius_meters: number;
  is_active: number;
  last_alert_at: number;
  created_at: string;
}

export interface BotAuthKey {
  auth_key: string;
  description: string | null;
  is_active: number;
  created_at: string;
}

// Verifica se una chiave di autorizzazione del Bot è valida e attiva
export function verifyBotAuthKey(key: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT auth_key FROM bot_auth_keys WHERE auth_key = ? AND is_active = 1').get(key.trim());
  return Boolean(row);
}

// Crea o aggiorna un iscritto al Bot Telegram
export function upsertTelegramSubscriber(data: {
  chat_id: string;
  username?: string | null;
  first_name?: string | null;
  auth_key?: string | null;
  is_authenticated?: number;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  alert_radius_meters?: number;
  is_active?: number;
  last_alert_at?: number;
}): void {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM telegram_subscribers WHERE chat_id = ?').get(data.chat_id) as TelegramSubscriber | undefined;

  if (existing) {
    db.prepare(`
      UPDATE telegram_subscribers SET
        username = COALESCE(?, username),
        first_name = COALESCE(?, first_name),
        auth_key = COALESCE(?, auth_key),
        is_authenticated = COALESCE(?, is_authenticated),
        address = COALESCE(?, address),
        latitude = COALESCE(?, latitude),
        longitude = COALESCE(?, longitude),
        alert_radius_meters = COALESCE(?, alert_radius_meters),
        is_active = COALESCE(?, is_active),
        last_alert_at = COALESCE(?, last_alert_at)
      WHERE chat_id = ?
    `).run(
      data.username ?? null,
      data.first_name ?? null,
      data.auth_key ?? null,
      data.is_authenticated ?? null,
      data.address ?? null,
      data.latitude ?? null,
      data.longitude ?? null,
      data.alert_radius_meters ?? null,
      data.is_active ?? null,
      data.last_alert_at ?? null,
      data.chat_id
    );
  } else {
    db.prepare(`
      INSERT INTO telegram_subscribers (
        chat_id, username, first_name, auth_key, is_authenticated,
        address, latitude, longitude, alert_radius_meters, is_active, last_alert_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.chat_id,
      data.username || null,
      data.first_name || null,
      data.auth_key || null,
      data.is_authenticated ?? 0,
      data.address || null,
      data.latitude || null,
      data.longitude || null,
      data.alert_radius_meters ?? 150,
      data.is_active ?? 1,
      data.last_alert_at ?? 0
    );
  }
}

// Recupera un iscritto dal suo chat_id
export function getTelegramSubscriber(chat_id: string): TelegramSubscriber | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM telegram_subscribers WHERE chat_id = ?').get(chat_id) as TelegramSubscriber | undefined;
}

// Recupera tutti gli iscritti attivi, autenticati e con coordinate configurate
export function getActiveAuthenticatedSubscribers(): TelegramSubscriber[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM telegram_subscribers 
    WHERE is_authenticated = 1 AND is_active = 1 AND latitude IS NOT NULL AND longitude IS NOT NULL
  `).all() as TelegramSubscriber[];
}

// Aggiorna il timestamp dell'ultima allerta inviata per prevenire spam
export function updateSubscriberLastAlert(chat_id: string, timestamp: number = Date.now()): void {
  const db = getDb();
  db.prepare('UPDATE telegram_subscribers SET last_alert_at = ? WHERE chat_id = ?').run(timestamp, chat_id);
}
