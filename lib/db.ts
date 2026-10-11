import Database from 'better-sqlite3';
import path from 'path';
import { hashPassword, generateBotApiKey } from './crypto-auth';

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
      business_name TEXT,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_used INTEGER NOT NULL DEFAULT 0,
      used_by_chat_id TEXT,
      used_at INTEGER,
      created_by TEXT,
      revoked_at INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'operator', -- 'superadmin' | 'operator'
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at INTEGER
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
      opening_hours TEXT,
      google_place_id TEXT,
      osm_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrazioni colonne bot_auth_keys per supporto chiavi monouso e indirizzo pre-configurato
  try { db.exec(`ALTER TABLE bot_auth_keys ADD COLUMN business_name TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE bot_auth_keys ADD COLUMN address TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE bot_auth_keys ADD COLUMN latitude REAL;`); } catch {}
  try { db.exec(`ALTER TABLE bot_auth_keys ADD COLUMN longitude REAL;`); } catch {}
  try { db.exec(`ALTER TABLE bot_auth_keys ADD COLUMN alert_radius_meters INTEGER NOT NULL DEFAULT 150;`); } catch {}
  try { db.exec(`ALTER TABLE bot_auth_keys ADD COLUMN is_used INTEGER NOT NULL DEFAULT 0;`); } catch {}
  try { db.exec(`ALTER TABLE bot_auth_keys ADD COLUMN used_by_chat_id TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE bot_auth_keys ADD COLUMN used_at INTEGER;`); } catch {}
  try { db.exec(`ALTER TABLE bot_auth_keys ADD COLUMN created_by TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE bot_auth_keys ADD COLUMN revoked_at INTEGER;`); } catch {}

  // Revoca permanente di tutte le chiavi di test fittizie e disattivazione account associati
  try {
    db.exec(`
      UPDATE bot_auth_keys 
      SET is_active = 0, revoked_at = strftime('%s','now')*1000 
      WHERE auth_key IN ('TORINO-ALERT-KEY-2026', 'BAR-SAN-SALVARIO-01', 'COMMERCIO-VIA-PO-14');
      
      UPDATE telegram_subscribers 
      SET is_authenticated = 0, is_active = 0, auth_key = NULL 
      WHERE auth_key IN ('TORINO-ALERT-KEY-2026', 'BAR-SAN-SALVARIO-01', 'COMMERCIO-VIA-PO-14')
         OR auth_key IS NULL;
    `);
  } catch (err) {
    console.warn('[DB] Revoca chiavi di test:', err);
  }

  // Inizializzazione Superadmin iniziale se tabella vuota
  try {
    const adminCount = db.prepare('SELECT count(*) as count FROM admin_users').get() as { count: number };
    if (adminCount.count === 0) {
      const initialUser = process.env.INITIAL_SUPERADMIN_USER || 'admin';
      const initialPass = process.env.INITIAL_SUPERADMIN_PASSWORD || 'AdminTorino2026!';
      const { hash, salt } = hashPassword(initialPass);
      db.prepare(`
        INSERT INTO admin_users (username, password_hash, salt, role, is_active, created_by)
        VALUES (?, ?, ?, 'superadmin', 1, 'system')
      `).run(initialUser, hash, salt);
      console.log(`[DB] Account Superadmin creato: ${initialUser}`);
    }
  } catch (err) {
    console.warn('[DB] Inizializzazione Superadmin:', err);
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

  // Migrazioni retrocompatibili per gli orari/apertura degli iscritti al bot
  try {
    db.exec(`ALTER TABLE telegram_subscribers ADD COLUMN opening_hours TEXT;`);
  } catch {
    // La colonna esiste già
  }
  try {
    db.exec(`ALTER TABLE telegram_subscribers ADD COLUMN google_place_id TEXT;`);
  } catch {
    // La colonna esiste già
  }
  try {
    db.exec(`ALTER TABLE telegram_subscribers ADD COLUMN osm_id TEXT;`);
  } catch {
    // La colonna esiste già
  }

  // Rimozione retrocompatibile di latitudine e longitudine dalla tabella delle letture (noise_readings) se presenti
  try {
    db.exec(`ALTER TABLE noise_readings DROP COLUMN latitude;`);
  } catch {
    // Non presente
  }
  try {
    db.exec(`ALTER TABLE noise_readings DROP COLUMN longitude;`);
  } catch {
    // Non presente
  }

  // Seleziona se ci sono stazioni dummy registrate; se mancano, inizializzale
  const dummyCount = db.prepare("SELECT count(*) as count FROM stations WHERE is_dummy = 1 OR id LIKE 'ard-to-%'").get() as { count: number };
  if (dummyCount.count === 0) {
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

export interface StationAdminItem extends Station {
  readings_count: number;
  current_intensity: number | null;
  last_reading_time: number | null;
}

export function listStationsAdmin(): StationAdminItem[] {
  const db = getDb();
  const query = `
    SELECT 
      s.id,
      s.name,
      s.latitude,
      s.longitude,
      s.is_dummy,
      s.created_at,
      COUNT(r.id) as readings_count,
      MAX(r.timestamp) as last_reading_time,
      (
        SELECT sound_intensity 
        FROM noise_readings 
        WHERE station_id = s.id 
        ORDER BY timestamp DESC, id DESC 
        LIMIT 1
      ) as current_intensity
    FROM stations s
    LEFT JOIN noise_readings r ON s.id = r.station_id
    GROUP BY s.id
    ORDER BY s.is_dummy ASC, s.name ASC
  `;
  return db.prepare(query).all() as StationAdminItem[];
}

export function createStation(input: {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  is_dummy?: boolean;
}): Station {
  const db = getDb();
  const cleanId = input.id.trim();
  const isDummyVal = input.is_dummy ? 1 : 0;

  db.prepare(`
    INSERT INTO stations (id, name, latitude, longitude, is_dummy, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(cleanId, input.name.trim(), input.latitude, input.longitude, isDummyVal);

  return db.prepare('SELECT * FROM stations WHERE id = ?').get(cleanId) as Station;
}

export function upsertStation(input: {
  id: string;
  name?: string;
  latitude?: number;
  longitude?: number;
  is_dummy?: boolean;
}): Station {
  const db = getDb();
  const cleanId = input.id.trim();
  const existing = db.prepare('SELECT * FROM stations WHERE id = ?').get(cleanId) as Station | undefined;
  if (existing) {
    return existing;
  }
  const name = input.name?.trim() || `Stazione (${cleanId})`;
  const lat = input.latitude ?? 45.0705;
  const lon = input.longitude ?? 7.6868;
  const isDummyVal = input.is_dummy ? 1 : 0;

  db.prepare(`
    INSERT INTO stations (id, name, latitude, longitude, is_dummy, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(cleanId, name, lat, lon, isDummyVal);

  return db.prepare('SELECT * FROM stations WHERE id = ?').get(cleanId) as Station;
}

export function updateStation(
  id: string,
  updates: {
    name?: string;
    latitude?: number;
    longitude?: number;
    is_dummy?: boolean;
  }
): Station | null {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM stations WHERE id = ?').get(id) as Station | undefined;
  if (!existing) return null;

  const newName = updates.name !== undefined ? updates.name.trim() : existing.name;
  const newLat = updates.latitude !== undefined ? updates.latitude : existing.latitude;
  const newLng = updates.longitude !== undefined ? updates.longitude : existing.longitude;
  const newDummy = updates.is_dummy !== undefined ? (updates.is_dummy ? 1 : 0) : existing.is_dummy;

  db.prepare(`
    UPDATE stations
    SET name = ?, latitude = ?, longitude = ?, is_dummy = ?
    WHERE id = ?
  `).run(newName, newLat, newLng, newDummy, id);

  return db.prepare('SELECT * FROM stations WHERE id = ?').get(id) as Station;
}

export function deleteStation(id: string): boolean {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM noise_readings WHERE station_id = ?').run(id);
    db.prepare('DELETE FROM noise_breaches WHERE station_id = ?').run(id);
    db.prepare('DELETE FROM noise_alerts WHERE station_id = ?').run(id);
    const result = db.prepare('DELETE FROM stations WHERE id = ?').run(id);
    return result.changes > 0;
  });
  return tx();
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
  opening_hours: string | null;
  google_place_id: string | null;
  osm_id: string | null;
  created_at: string;
}

export interface BotAuthKey {
  auth_key: string;
  business_name: string | null;
  description: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  alert_radius_meters: number;
  is_active: number;
  is_used: number;
  used_by_chat_id: string | null;
  used_at: number | null;
  created_by: string | null;
  revoked_at: number | null;
  created_at: string;
}

export interface AdminUser {
  id: number;
  username: string;
  password_hash: string;
  salt: string;
  role: 'superadmin' | 'operator';
  is_active: number;
  created_by: string | null;
  created_at: string;
  last_login_at: number | null;
}

// Verifica se una chiave di autorizzazione del Bot è valida, attiva e non ancora utilizzata
export function verifyBotAuthKey(key: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT auth_key FROM bot_auth_keys WHERE auth_key = ? AND is_active = 1 AND is_used = 0').get(key.trim());
  return Boolean(row);
}

// Riscatta una chiave monouso per conto di una chat Telegram e associa automaticamente indirizzo e coordinate pre-configurati dall'amministratore
export function redeemBotAuthKey(
  key: string,
  chatId: string
): {
  success: boolean;
  error?: string;
  business_name?: string;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  alert_radius_meters?: number;
} {
  const db = getDb();
  const cleanKey = key.trim();
  const row = db
    .prepare('SELECT * FROM bot_auth_keys WHERE auth_key = ?')
    .get(cleanKey) as BotAuthKey | undefined;

  if (!row || row.is_active !== 1) {
    return {
      success: false,
      error: 'Chiave non valida o revocata dall\'amministrazione.',
    };
  }

  if (row.is_used === 1) {
    if (row.used_by_chat_id === chatId) {
      return {
        success: true,
        business_name: row.business_name || row.description || 'Attività registrata',
        address: row.address,
        latitude: row.latitude,
        longitude: row.longitude,
        alert_radius_meters: row.alert_radius_meters || 150,
      };
    }
    return {
      success: false,
      error: 'Questa chiave è già stata utilizzata da un\'altra utenza. Ogni chiave è strettamente monouso.',
    };
  }

  // Riscatto completato: segna la chiave come usata dalla chat
  db.prepare(`
    UPDATE bot_auth_keys 
    SET is_used = 1, used_by_chat_id = ?, used_at = ? 
    WHERE auth_key = ?
  `).run(chatId, Date.now(), row.auth_key);

  // CAMBIO DI PARADIGMA: associa automaticamente all'iscritto Telegram la via, le coordinate e il raggio inseriti dall'amministratore
  upsertTelegramSubscriber({
    chat_id: chatId,
    auth_key: row.auth_key,
    is_authenticated: 1,
    is_active: 1,
    address: row.address || row.business_name || 'Torino',
    latitude: row.latitude,
    longitude: row.longitude,
    alert_radius_meters: row.alert_radius_meters || 150,
  });

  return {
    success: true,
    business_name: row.business_name || row.description || 'Attività registrata',
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    alert_radius_meters: row.alert_radius_meters || 150,
  };
}

// Crea una nuova chiave monouso per un'attività con indirizzo e coordinate geocodificate dall'amministratore
export function createBotAuthKey(
  input: string | {
    businessName: string;
    address?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    alertRadiusMeters?: number;
    createdBy?: string;
  },
  fallbackCreatedBy: string = 'admin'
): BotAuthKey {
  const db = getDb();
  const newKey = generateBotApiKey();

  let businessName = '';
  let address: string | null = null;
  let latitude: number | null = null;
  let longitude: number | null = null;
  let alertRadiusMeters = 150;
  let createdBy = fallbackCreatedBy;

  if (typeof input === 'string') {
    businessName = input.trim();
  } else {
    businessName = input.businessName.trim();
    address = input.address ? input.address.trim() : null;
    latitude = input.latitude ?? null;
    longitude = input.longitude ?? null;
    alertRadiusMeters = input.alertRadiusMeters || 150;
    createdBy = input.createdBy || fallbackCreatedBy;
  }

  db.prepare(`
    INSERT INTO bot_auth_keys (
      auth_key, business_name, description, address, latitude, longitude, alert_radius_meters, is_active, is_used, created_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?)
  `).run(
    newKey,
    businessName,
    `Chiave per ${businessName}`,
    address,
    latitude,
    longitude,
    alertRadiusMeters,
    createdBy
  );

  return db.prepare('SELECT * FROM bot_auth_keys WHERE auth_key = ?').get(newKey) as BotAuthKey;
}

// Revoca una chiave monouso e disattiva contestualmente l'accesso alla chat che la usava
export function revokeBotAuthKey(key: string): boolean {
  const db = getDb();
  const cleanKey = key.trim();
  const res = db.prepare(`
    UPDATE bot_auth_keys 
    SET is_active = 0, revoked_at = ? 
    WHERE auth_key = ?
  `).run(Date.now(), cleanKey);

  // Revoca immediata all'utenza Telegram collegata
  db.prepare(`
    UPDATE telegram_subscribers 
    SET is_authenticated = 0, is_active = 0 
    WHERE auth_key = ?
  `).run(cleanKey);

  return res.changes > 0;
}

// Elenco di tutte le chiavi autorizzazione
export function listBotAuthKeys(): BotAuthKey[] {
  const db = getDb();
  return db.prepare('SELECT * FROM bot_auth_keys ORDER BY created_at DESC').all() as BotAuthKey[];
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
  opening_hours?: string | null;
  google_place_id?: string | null;
  osm_id?: string | null;
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
        last_alert_at = COALESCE(?, last_alert_at),
        opening_hours = COALESCE(?, opening_hours),
        google_place_id = COALESCE(?, google_place_id),
        osm_id = COALESCE(?, osm_id)
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
      data.opening_hours ?? null,
      data.google_place_id ?? null,
      data.osm_id ?? null,
      data.chat_id
    );
  } else {
    db.prepare(`
      INSERT INTO telegram_subscribers (
        chat_id, username, first_name, auth_key, is_authenticated,
        address, latitude, longitude, alert_radius_meters, is_active, last_alert_at,
        opening_hours, google_place_id, osm_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      data.last_alert_at ?? 0,
      data.opening_hours || null,
      data.google_place_id || null,
      data.osm_id || null
    );
  }
}

// Imposta lo stato di attività di un iscritto (per il comando /stop)
export function setSubscriberActive(chat_id: string, is_active: number): number {
  const db = getDb();
  const result = db.prepare('UPDATE telegram_subscribers SET is_active = ? WHERE chat_id = ?').run(is_active, chat_id);
  return result.changes;
}

// Conteggi per l'endpoint di osservabilità
export function getSubscriberStats(): { total: number; active: number; authenticated: number } {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN is_authenticated = 1 THEN 1 ELSE 0 END) as authenticated
    FROM telegram_subscribers
  `).get() as { total: number; active: number | null; authenticated: number | null };
  return {
    total: row.total ?? 0,
    active: row.active ?? 0,
    authenticated: row.authenticated ?? 0,
  };
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

// ==========================================
// GESTIONE UTENTI AMMINISTRATIVI (RBAC)
// ==========================================

export function getAdminUserByUsername(username: string): AdminUser | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM admin_users WHERE username = ? AND is_active = 1').get(username.trim()) as AdminUser | undefined;
}

export function getAdminUserById(id: number): AdminUser | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM admin_users WHERE id = ? AND is_active = 1').get(id) as AdminUser | undefined;
}

export function listAdminUsers(): Omit<AdminUser, 'password_hash' | 'salt'>[] {
  const db = getDb();
  return db.prepare(`
    SELECT id, username, role, is_active, created_by, created_at, last_login_at 
    FROM admin_users 
    ORDER BY id ASC
  `).all() as Omit<AdminUser, 'password_hash' | 'salt'>[];
}

export function createAdminUser(
  username: string,
  passwordHash: string,
  salt: string,
  role: 'superadmin' | 'operator',
  createdBy: string
): Omit<AdminUser, 'password_hash' | 'salt'> {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO admin_users (username, password_hash, salt, role, is_active, created_by)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(username.trim(), passwordHash, salt, role, createdBy);

  return db.prepare(`
    SELECT id, username, role, is_active, created_by, created_at, last_login_at 
    FROM admin_users WHERE id = ?
  `).get(result.lastInsertRowid) as Omit<AdminUser, 'password_hash' | 'salt'>;
}

export function deactivateAdminUser(
  targetUserId: number,
  requestingUser: { id: number; role: 'superadmin' | 'operator' }
): { success: boolean; error?: string } {
  const db = getDb();

  // Regola di sicurezza: solo un superadmin può revocare le utenze
  if (requestingUser.role !== 'superadmin') {
    return {
      success: false,
      error: 'Operazione non consentita: solo l\'amministratore principale può revocare le utenze.',
    };
  }

  // Non ci si può auto-revocare
  if (requestingUser.id === targetUserId) {
    return {
      success: false,
      error: 'Non puoi revocare la tua stessa utenza amministratore in sessione.',
    };
  }

  const target = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(targetUserId) as AdminUser | undefined;
  if (!target) {
    return { success: false, error: 'Utenza non trovata.' };
  }

  // Non è MAI possibile revocare un superadmin
  if (target.role === 'superadmin') {
    return {
      success: false,
      error: 'Impossibile revocare l\'utenza di un amministratore principale (superadmin).',
    };
  }

  db.prepare('UPDATE admin_users SET is_active = 0 WHERE id = ?').run(targetUserId);
  return { success: true };
}

export function updateAdminLastLogin(id: number): void {
  const db = getDb();
  db.prepare('UPDATE admin_users SET last_login_at = ? WHERE id = ?').run(Date.now(), id);
}

