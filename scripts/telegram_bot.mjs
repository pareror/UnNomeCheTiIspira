#!/usr/bin/env node
/**
 * Telegram Alert Bot Runner per Torino Noise Monitor
 * Bot: @NoiseTurin_bot (Token: 8953155660:AAGi6tbaqxQOEmVEGAvpaw1ma70UeIJaUro)
 * 
 * Gestisce l'onboarding e l'autenticazione tramite chiave univoca,
 * l'acquisizione dell'indirizzo dell'attività (via + civico a Torino),
 * il calcolo geodetico rigoroso delle celle acustiche entro il raggio (default 150m, parametrizzato),
 * e la notifica tempestiva in caso di superamento delle soglie acustiche.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Caricamento sicuro delle credenziali da file .env.local o .env
if (fs.existsSync('.env.local')) {
  process.loadEnvFile?.('.env.local');
} else if (fs.existsSync('.env')) {
  process.loadEnvFile?.('.env');
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ ERRORE CRITICO: TELEGRAM_BOT_TOKEN non configurato nel file .env.local o .env!');
  process.exit(1);
}
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'noise_monitor.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Revoca immediata di tutte le vecchie chiavi fittizie di test
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
} catch (e) {}

// -------------------------------------------------------------
// FUNZIONI GEODETICHE ED EURISTICHE (TORINO)
// -------------------------------------------------------------

function calculateHaversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

const TURIN_KNOWN_STREETS = {
  'via po': { lat: 45.0688, lon: 7.6888, name: 'Via Po, Centro, Torino' },
  'via roma': { lat: 45.0667, lon: 7.6828, name: 'Via Roma, Centro, Torino' },
  'piazza castello': { lat: 45.0709, lon: 7.6861, name: 'Piazza Castello, Centro, Torino' },
  'piazza san carlo': { lat: 45.0677, lon: 7.6830, name: 'Piazza San Carlo, Centro, Torino' },
  'piazza vittorio': { lat: 45.0645, lon: 7.6953, name: 'Piazza Vittorio Veneto, Torino' },
  'via garibaldi': { lat: 45.0734, lon: 7.6806, name: 'Via Giuseppe Garibaldi, Centro, Torino' },
  'via baretti': { lat: 45.0569, lon: 7.6812, name: 'Via Baretti, San Salvario, Torino' },
  'piazza santa giulia': { lat: 45.0673, lon: 7.6961, name: 'Piazza Santa Giulia, Vanchiglia, Torino' },
  'corso francia': { lat: 45.0768, lon: 7.6681, name: 'Corso Francia, Torino' },
  'porta nuova': { lat: 45.0621, lon: 7.6789, name: 'Piazza Carlo Felice / Porta Nuova, Torino' },
  'murazzi': { lat: 45.0628, lon: 7.6934, name: 'Murazzi del Po, Torino' },
};

async function geocodeTurinAddress(address) {
  let query = address.trim();
  if (!query.toLowerCase().includes('torino')) {
    query = `${query}, Torino, Italia`;
  }

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
      query
    )}&countrycodes=it`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'TorinoNoiseBot/1.0 (noise-bot@antigravity.local)' },
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        return {
          lat: parseFloat(data[0].lat),
          lon: parseFloat(data[0].lon),
          displayName: data[0].display_name,
        };
      }
    }
  } catch (err) {
    console.warn(`[Nominatim Warning] Geocoding fallback per "${address}":`, err.message);
  }

  const lower = query.toLowerCase();
  for (const [key, val] of Object.entries(TURIN_KNOWN_STREETS)) {
    if (lower.includes(key)) {
      return {
        lat: val.lat,
        lon: val.lon,
        displayName: `${address} (${val.name})`,
      };
    }
  }

  return {
    lat: 45.0705,
    lon: 7.6868,
    displayName: `${address}, Torino (Coordinate centro approssimate)`,
  };
}

// -------------------------------------------------------------
// DATABASE ACCESS HELPERS
// -------------------------------------------------------------

function getSubscriber(chatId) {
  return db.prepare('SELECT * FROM telegram_subscribers WHERE chat_id = ?').get(String(chatId));
}

function redeemAuthKey(key, chatId) {
  const cleanKey = (key || '').trim();
  const row = db.prepare('SELECT * FROM bot_auth_keys WHERE auth_key = ?').get(cleanKey);
  if (!row || row.is_active !== 1) {
    return {
      success: false,
      error: 'Chiave non valida o revocata dall\'amministrazione.',
    };
  }
  if (row.is_used === 1) {
    if (row.used_by_chat_id === String(chatId)) {
      return {
        success: true,
        businessName: row.business_name || row.description || 'Attività registrata',
        address: row.address,
        latitude: row.latitude,
        longitude: row.longitude,
        radius: row.alert_radius_meters || 150,
      };
    }
    return {
      success: false,
      error: 'Questa chiave è già stata utilizzata da un\'altra utenza. Ogni chiave è strettamente monouso.',
    };
  }

  // Riscatto effettuato con successo: marca la chiave come usata
  db.prepare(`
    UPDATE bot_auth_keys 
    SET is_used = 1, used_by_chat_id = ?, used_at = ? 
    WHERE auth_key = ?
  `).run(String(chatId), Date.now(), row.auth_key);

  // CAMBIO DI PARADIGMA: assegna istantaneamente all'iscritto Telegram la sede e le coordinate impostate dall'amministratore
  upsertSubscriber({
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
    businessName: row.business_name || row.description || 'Attività registrata',
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    radius: row.alert_radius_meters || 150,
  };
}

function upsertSubscriber(data) {
  const existing = getSubscriber(data.chat_id);
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
        is_active = COALESCE(?, is_active)
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
      String(data.chat_id)
    );
  } else {
    db.prepare(`
      INSERT INTO telegram_subscribers (
        chat_id, username, first_name, auth_key, is_authenticated,
        address, latitude, longitude, alert_radius_meters, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(data.chat_id),
      data.username || null,
      data.first_name || null,
      data.auth_key || null,
      data.is_authenticated ?? 0,
      data.address || null,
      data.latitude || null,
      data.longitude || null,
      data.alert_radius_meters ?? 150,
      data.is_active ?? 1
    );
  }
}

function getAllStationsFromDb() {
  return db.prepare('SELECT id, name, latitude, longitude, is_dummy FROM stations').all();
}

// -------------------------------------------------------------
// TELEGRAM API CLIENT
// -------------------------------------------------------------

async function sendMessage(chatId, text, parseMode = 'HTML') {
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });
    return await res.json();
  } catch (err) {
    console.error(`[Telegram] Errore invio messaggio a ${chatId}:`, err);
    return { ok: false, error: err.message };
  }
}

// -------------------------------------------------------------
// LOGICA DI GESTIONE DEI MESSAGGI
// -------------------------------------------------------------

async function handleIncomingMessage(msg) {
  const chatId = msg.chat.id;
  const rawText = msg.text ? msg.text.trim() : '';
  const username = msg.from.username || '';
  const firstName = msg.from.first_name || 'Utente';

  if (!rawText) return;

  const subscriber = getSubscriber(chatId);
  const isAuth = Boolean(subscriber && subscriber.is_authenticated);

  console.log(`[Bot In] Chat ${chatId} (${firstName}): "${rawText}" | Auth: ${isAuth}`);

  // 1. Comando /start
  if (rawText.startsWith('/start')) {
    const parts = rawText.split(/\s+/);
    const possibleKey = parts[1];

    if (possibleKey) {
      const redeem = redeemAuthKey(possibleKey, chatId);
      if (redeem.success) {
        let stationsMsg = '';
        if (redeem.latitude && redeem.longitude) {
          const stations = getAllStationsFromDb();
          const inRange = [];
          for (const st of stations) {
            const d = calculateHaversineDistanceMeters(redeem.latitude, redeem.longitude, st.latitude, st.longitude);
            if (d <= redeem.radius) inRange.push({ st, d });
          }
          inRange.sort((a, b) => a.d - b.d);
          if (inRange.length > 0) {
            stationsMsg = `\n\n📡 <b>Celle Acustiche nel tuo raggio (${inRange.length}):</b>\n` +
              inRange.map(m => `• <b>${m.st.name}</b> (a ${Math.round(m.d)}m)`).join('\n');
          } else {
            stationsMsg = `\n\nℹ️ <i>Nessuna stazione rilevata entro ${redeem.radius}m.</i>`;
          }
        }

        await sendMessage(
          chatId,
          `✅ <b>Autenticazione riuscita con successo!</b>\n\n` +
          `🏢 <b>Attività:</b> ${redeem.businessName}\n` +
          `📍 <b>Sede Registrata:</b> ${redeem.address || 'Torino'}\n` +
          (redeem.latitude ? `🌐 <b>Coordinate:</b> <code>${redeem.latitude.toFixed(5)}° N, ${redeem.longitude.toFixed(5)}° E</code>\n` : '') +
          `📏 <b>Raggio Allerta:</b> <b>${redeem.radius} metri</b>` +
          stationsMsg +
          `\n\n🟢 <b>Monitoraggio ATTIVO:</b> <i>Riceverai avvisi automatici in tempo reale se il rumore attorno alla tua attività supera i 70 dB.</i>`
        );
        return;
      } else {
        await sendMessage(
          chatId,
          `❌ <b>Autenticazione non riuscita:</b>\n${redeem.error || 'Chiave non valida o revocata.'}\n\n` +
          `Richiedi una nuova chiave monouso all'amministratore del servizio.`
        );
        return;
      }
    }

    if (isAuth) {
      const radius = subscriber.alert_radius_meters || 150;
      await sendMessage(
        chatId,
        `👋 Bentornato <b>${firstName}</b>!\n\n` +
        `🏢 <b>Sede Registrata:</b> ${subscriber.address || 'Torino'}\n` +
        `📏 <b>Raggio di allerta:</b> <b>${radius} metri</b>\n\n` +
        `<b>Comandi disponibili:</b>\n` +
        `• <code>/stazioni</code> - Elenco sensori nel tuo perimetro (${radius}m)\n` +
        `• <code>/raggio &lt;metri&gt;</code> - Modifica raggio di copertura (es: /raggio 150)\n` +
        `• <code>/stato</code> - Riepilogo configurazione attiva\n` +
        `• <code>/test_allerta</code> - Simula una notifica di rumore critico\n` +
        `• <code>/aiuto</code> - Guida comandi`
      );
    } else {
      upsertSubscriber({ chat_id: chatId, username, first_name: firstName });
      await sendMessage(
        chatId,
        `👋 <b>Benvenuto nel Sistema Allerte Acustiche Torino Noise!</b>\n\n` +
        `Questo bot monitora le emissioni sonore urbane attorno alla tua attività e ti invia avvisi istantanei se il rumore supera i livelli consentiti.\n\n` +
        `🔐 <b>Autenticazione Richiesta:</b>\n` +
        `Per procedere, invia la <b>chiave di accesso monouso</b> rilasciata dall'amministrazione per la tua attività (es: <code>/login CHIAVE</code> oppure invia direttamente il codice):`
      );
    }
    return;
  }

  // 2. Comando /login <chiave> o tentativo di autenticazione tramite testo
  if (rawText.startsWith('/login') || !isAuth) {
    let keyToTest = rawText;
    if (rawText.startsWith('/login')) {
      const parts = rawText.split(/\s+/);
      keyToTest = parts.slice(1).join(' ').trim();
    }

    if (!keyToTest) {
      await sendMessage(chatId, `⚠️ Inserisci la chiave univoca rilasciata dall'amministratore. Esempio:\n<code>/login TN-XXXX-XXXX</code>`);
      return;
    }

    const redeem = redeemAuthKey(keyToTest, chatId);
    if (redeem.success) {
      let stationsMsg = '';
      if (redeem.latitude && redeem.longitude) {
        const stations = getAllStationsFromDb();
        const inRange = [];
        for (const st of stations) {
          const d = calculateHaversineDistanceMeters(redeem.latitude, redeem.longitude, st.latitude, st.longitude);
          if (d <= redeem.radius) inRange.push({ st, d });
        }
        inRange.sort((a, b) => a.d - b.d);
        if (inRange.length > 0) {
          stationsMsg = `\n\n📡 <b>Celle Acustiche nel tuo raggio (${inRange.length}):</b>\n` +
            inRange.map(m => `• <b>${m.st.name}</b> (a ${Math.round(m.d)}m)`).join('\n');
        } else {
          stationsMsg = `\n\nℹ️ <i>Nessuna stazione rilevata entro ${redeem.radius}m.</i>`;
        }
      }

      await sendMessage(
        chatId,
        `✅ <b>Autenticazione riuscita!</b>\n\n` +
        `🏢 <b>Attività:</b> ${redeem.businessName}\n` +
        `📍 <b>Sede Registrata:</b> ${redeem.address || 'Torino'}\n` +
        (redeem.latitude ? `🌐 <b>Coordinate:</b> <code>${redeem.latitude.toFixed(5)}° N, ${redeem.longitude.toFixed(5)}° E</code>\n` : '') +
        `📏 <b>Raggio Allerta:</b> <b>${redeem.radius} metri</b>` +
        stationsMsg +
        `\n\n🟢 <b>Monitoraggio ATTIVO:</b> <i>Riceverai avvisi automatici in tempo reale se il rumore attorno alla tua attività supera i 70 dB.</i>`
      );
      return;
    } else {
      await sendMessage(
        chatId,
        `❌ <b>Autenticazione non riuscita:</b>\n${redeem.error || 'Chiave non valida o già utilizzata.'}\n\n` +
        `Assicurati di inserire la chiave monouso fornita dall'amministratore.`
      );
      return;
    }
  }

  // UTENTE AUTENTICATO DA QUESTO PUNTO IN POI

  // 3. Modifica raggio: /raggio <metri>
  if (rawText.startsWith('/raggio')) {
    const parts = rawText.split(/\s+/);
    const newRadius = parseFloat(parts[1]);

    if (!newRadius || isNaN(newRadius) || newRadius < 20 || newRadius > 5000) {
      await sendMessage(
        chatId,
        `⚠️ Raggio non valido. Inserisci un valore tra 20 e 5000 metri.\nEsempio: <code>/raggio 150</code>`
      );
      return;
    }

    upsertSubscriber({
      chat_id: chatId,
      alert_radius_meters: newRadius,
    });

    const updatedSub = getSubscriber(chatId);
    let stationsMsg = '';
    if (updatedSub.latitude && updatedSub.longitude) {
      const stations = getAllStationsFromDb();
      const inRange = [];
      for (const st of stations) {
        const d = calculateHaversineDistanceMeters(updatedSub.latitude, updatedSub.longitude, st.latitude, st.longitude);
        if (d <= newRadius) inRange.push({ st, d });
      }
      inRange.sort((a, b) => a.d - b.d);

      if (inRange.length > 0) {
        stationsMsg = `\n\n📡 <b>Celle/Sensori coperti (${inRange.length}):</b>\n` +
          inRange.map(item => `• <b>${item.st.name}</b> (a ${Math.round(item.d)}m)`).join('\n');
      } else {
        stationsMsg = `\n\nℹ️ <i>Nessuna stazione attualmente presente entro ${newRadius}m dalla tua sede.</i>`;
      }
    }

    await sendMessage(
      chatId,
      `🎯 <b>Raggio di allerta aggiornato a ${newRadius} metri!</b>${stationsMsg}`
    );
    return;
  }

  // 4. Elenco stazioni nel perimetro: /stazioni
  if (rawText === '/stazioni') {
    if (!subscriber.latitude || !subscriber.longitude) {
      await sendMessage(chatId, `⚠️ Devi prima impostare un indirizzo. Invia via e numero civico (es: <code>Via Po 14</code>).`);
      return;
    }

    const radius = subscriber.alert_radius_meters || 150;
    const stations = getAllStationsFromDb();
    const inRange = [];

    for (const st of stations) {
      const d = calculateHaversineDistanceMeters(subscriber.latitude, subscriber.longitude, st.latitude, st.longitude);
      if (d <= radius) inRange.push({ st, d });
    }
    inRange.sort((a, b) => a.d - b.d);

    if (inRange.length === 0) {
      await sendMessage(
        chatId,
        `ℹ️ <b>Nessuna cella acustica entro ${radius}m dalla tua sede.</b>\n` +
        `🏢 Sede: ${subscriber.address}\n` +
        `Puoi ampliare il perimetro con <code>/raggio &lt;metri&gt;</code> (es: <code>/raggio 300</code>).`
      );
    } else {
      const list = inRange.map((m, idx) => `${idx + 1}. <b>${m.st.name}</b> [<code>${m.st.id}</code>]\n   ↳ Distanza: <b>${Math.round(m.d)} metri</b>`).join('\n\n');
      await sendMessage(
        chatId,
        `📡 <b>Celle Acustiche attive nel tuo raggio di ${radius}m (${inRange.length}):</b>\n\n${list}\n\n` +
        `🔔 <i>Riceverai un avviso se una di queste stazioni rileva rumori oltre soglia.</i>`
      );
    }
    return;
  }

  // 5. Stato del monitoraggio: /stato
  if (rawText === '/stato') {
    const radius = subscriber.alert_radius_meters || 150;
    const stations = getAllStationsFromDb();
    let countInRange = 0;

    if (subscriber.latitude && subscriber.longitude) {
      for (const st of stations) {
        const d = calculateHaversineDistanceMeters(subscriber.latitude, subscriber.longitude, st.latitude, st.longitude);
        if (d <= radius) countInRange++;
      }
    }

    const now = Date.now();
    const cooldownMs = 10 * 60 * 1000;
    const lastAlert = subscriber.last_alert_at || 0;
    const isCooldownActive = lastAlert > 0 && (now - lastAlert) < cooldownMs;
    const remainingMin = isCooldownActive ? Math.ceil((cooldownMs - (now - lastAlert)) / 60000) : 0;
    const lastAlertText = lastAlert > 0 ? new Date(lastAlert).toLocaleTimeString('it-IT') : 'Nessuna allerta recente';

    await sendMessage(
      chatId,
      `📊 <b>STATO DEL MONITORAGGIO ACUSTICO</b>\n\n` +
      `👤 <b>Utente:</b> ${firstName} (@${username || 'N/A'})\n` +
      `🔑 <b>Chiave:</b> <code>${subscriber.auth_key}</code> (Attiva)\n` +
      `🏢 <b>Sede:</b> ${subscriber.address || '<i>Da configurare</i>'}\n` +
      `📍 <b>Coordinate:</b> ${subscriber.latitude ? `${subscriber.latitude.toFixed(5)}° N, ${subscriber.longitude.toFixed(5)}° E` : 'Non impostate'}\n` +
      `📏 <b>Raggio Monitorato:</b> <b>${radius} metri</b>\n` +
      `📡 <b>Celle in ascolto nel raggio:</b> <b>${countInRange} stazioni</b>\n` +
      `🔊 <b>Soglia di Allarme:</b> <b>≥ 70 dB</b>\n` +
      `⏱️ <b>Anti-Spam:</b> <b>10 minuti di intervallo minimo</b>\n` +
      `🕒 <b>Ultima Notifica:</b> ${lastAlertText} ${isCooldownActive ? `(⏳ Cooldown attivo: ancora ${remainingMin}m)` : '(Pronto a ricevere)'}\n\n` +
      `🟢 <b>Stato Allerte:</b> <b>ATTIVO</b>`
    );
    return;
  }

  // 6. Test di allerta simulata: /test_allerta
  if (rawText === '/test_allerta') {
    const radius = subscriber.alert_radius_meters || 150;
    const addr = subscriber.address || 'Via di Prova 1, Torino';
    await sendMessage(
      chatId,
      `🚨 <b>TEST ALLERTA RUMORE CRITICO A TORINO</b> 🚨\n\n` +
      `⚠️ <b>Livello Acustico Simulato:</b> <code>75 dB</code> (SOGLIA ≥ 70 dB SUPERATA)\n` +
      `📡 <b>Cella Acustica:</b> <b>Arduino Uno Q Test</b> [<code>ard-uno-q-real-mic</code>]\n` +
      `📍 <b>Distanza dalla tua attività:</b> <b>42 metri</b> (Entro il tuo raggio di ${radius}m)\n` +
      `🏢 <b>Tua Sede:</b> ${addr}\n` +
      `🕒 <b>Rilevamento:</b> ${new Date().toLocaleTimeString('it-IT')}\n\n` +
      `🛡️ <i>Protezione anti-spam attiva: tra un avviso e l'altro per la tua attività intercorrono almeno 10 minuti.</i>\n` +
      `✅ <i>Questo è un messaggio di test. Il tuo canale di ricezione Telegram funziona perfettamente!</i>`
    );
    return;
  }

  // 7. Aiuto: /aiuto
  if (rawText === '/aiuto' || rawText === '/help') {
    await sendMessage(
      chatId,
      `📖 <b>GUIDA COMANDI BOT TORINO NOISE</b>\n\n` +
      `• <code>/stazioni</code> - Elenco sensori nel tuo perimetro di monitoraggio\n` +
      `• <code>/raggio &lt;metri&gt;</code> - Modifica raggio di allerta (default: 150m, es: /raggio 200)\n` +
      `• <code>/stato</code> - Riepilogo sede registrata, coordinate e timer anti-spam\n` +
      `• <code>/test_allerta</code> - Invia una simulazione di notifica sonora\n\n` +
      `🔒 <i>Nota: La sede della tua attività è pre-configurata e certificata dall'amministrazione comunale all'emissione della chiave monouso.</i>`
    );
    return;
  }

  // 8. Ricezione di testo libero da utente autenticato: promemoria sede certificata dall'amministrazione
  await sendMessage(
    chatId,
    `ℹ️ <b>Sede della tua attività già registrata:</b>\n` +
    `🏢 <b>${subscriber.address || 'Torino'}</b>\n\n` +
    `🔒 <i>Per garantire la massima precisione ed evitare errori di sintassi o localizzazione, la sede è gestita e validata direttamente dall'amministrazione comunale.</i>\n\n` +
    `• Usa <code>/stazioni</code> per verificare le celle nel tuo perimetro.\n` +
    `• Usa <code>/stato</code> per consultare la tua configurazione attiva.\n` +
    `• Se devi modificare o correggere la sede, contatta l'amministratore del servizio.`
  );
}

// Registra i comandi ufficiali con la Bot API per abilitare il menu popup di autocompletamento quando l'utente digita "/"
async function registerBotCommands() {
  const commands = [
    { command: 'start', description: 'Avvia il bot e inserisci la chiave univoca' },
    { command: 'raggio', description: 'Imposta il raggio di allerta in metri (es: /raggio 150)' },
    { command: 'stazioni', description: 'Elenco celle acustiche monitorate nel tuo raggio' },
    { command: 'stato', description: 'Riepilogo sede, coordinate, raggio e timer anti-spam' },
    { command: 'test_allerta', description: 'Invia una notifica di prova simulata' },
    { command: 'aiuto', description: 'Guida e istruzioni per configurare la tua attività' },
  ];

  try {
    const res = await fetch(`${TELEGRAM_API}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
    const data = await res.json();
    if (data.ok) {
      console.log('✅ Menu popup dei comandi Telegram registrato con successo (setMyCommands OK)');
    } else {
      console.warn('⚠️ Registrazione comandi Telegram:', data.description);
    }
  } catch (err) {
    console.error('❌ Errore chiamata setMyCommands:', err.message);
  }
}

async function startBotPolling() {
  console.log('========================================================');
  console.log('🤖 AVVIO TELEGRAM BOT: @NoiseTurin_bot');
  console.log('🔑 Token configurato:', BOT_TOKEN.slice(0, 10) + '...');
  console.log('📡 Database SQLite:', dbPath);
  console.log('========================================================');

  // Verifica connessione al bot
  try {
    const meRes = await fetch(`${TELEGRAM_API}/getMe`);
    const meData = await meRes.json();
    if (!meData.ok) {
      console.error('❌ Errore token Telegram:', meData.description);
      process.exit(1);
    }
    console.log(`✅ Connesso a Telegram come: @${meData.result.username} (${meData.result.first_name})`);
  } catch (err) {
    console.error('❌ Errore connessione a Telegram API:', err.message);
    process.exit(1);
  }

  // Registrazione del menu comandi popup per l'autocompletamento digitando "/"
  await registerBotCommands();

  let offset = 0;

  while (true) {
    try {
      const url = `${TELEGRAM_API}/getUpdates?offset=${offset}&timeout=20`;
      const res = await fetch(url);
      const data = await res.json();

      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          if (update.message) {
            await handleIncomingMessage(update.message);
          }
        }
      } else if (!data.ok) {
        console.warn('[Telegram Poll Warning]:', data.description);
        await new Promise(r => setTimeout(r, 3000));
      }
    } catch (err) {
      console.error('[Telegram Poll Error]:', err.message);
      await new Promise(r => setTimeout(r, 4000));
    }
  }
}

startBotPolling();
