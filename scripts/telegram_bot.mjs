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

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8953155660:AAGi6tbaqxQOEmVEGAvpaw1ma70UeIJaUro';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const dbPath = path.join(process.cwd(), 'noise_monitor.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

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

function verifyAuthKey(key) {
  const row = db.prepare('SELECT auth_key FROM bot_auth_keys WHERE auth_key = ? AND is_active = 1').get(key.trim());
  return Boolean(row);
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
      if (verifyAuthKey(possibleKey)) {
        upsertSubscriber({
          chat_id: chatId,
          username,
          first_name: firstName,
          auth_key: possibleKey,
          is_authenticated: 1,
        });
        await sendMessage(
          chatId,
          `✅ <b>Autenticazione riuscita con successo!</b>\n\n` +
          `Chiave attivata: <code>${possibleKey}</code>\n\n` +
          `📍 <b>Ora imposta la sede della tua attività a Torino:</b>\n` +
          `Invia semplicemente la <b>via e il numero civico</b> (es: <code>Via Po 14</code> oppure <code>Via Roma 10</code>):`
        );
        return;
      } else {
        await sendMessage(
          chatId,
          `❌ <b>Chiave non valida o non attiva.</b>\nVerifica il codice univoco fornito o usa /login per riprovare.`
        );
        return;
      }
    }

    if (isAuth) {
      const radius = subscriber.alert_radius_meters || 150;
      await sendMessage(
        chatId,
        `👋 Bentornato <b>${firstName}</b>!\n\n` +
        `🏢 <b>Sede attuale:</b> ${subscriber.address || '<i>Nessun indirizzo impostato</i>'}\n` +
        `📏 <b>Raggio di allerta:</b> <b>${radius} metri</b>\n\n` +
        `<b>Comandi disponibili:</b>\n` +
        `• Invia un indirizzo (es: <code>Via Po 14</code>) per cambiare sede\n` +
        `• <code>/raggio &lt;metri&gt;</code> - Modifica raggio di copertura (es: /raggio 150)\n` +
        `• <code>/stazioni</code> - Elenco sensori nel tuo perimetro (${radius}m)\n` +
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
        `Per procedere, invia la tua <b>chiave di accesso univoca</b> (es: <code>TORINO-ALERT-KEY-2026</code> oppure usa <code>/login CHIAVE</code>):`
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
      await sendMessage(chatId, `⚠️ Inserisci la chiave univoca. Esempio:\n<code>/login TORINO-ALERT-KEY-2026</code>`);
      return;
    }

    if (verifyAuthKey(keyToTest)) {
      upsertSubscriber({
        chat_id: chatId,
        username,
        first_name: firstName,
        auth_key: keyToTest,
        is_authenticated: 1,
      });
      await sendMessage(
        chatId,
        `✅ <b>Autenticazione riuscita!</b>\n\n` +
        `🔑 Chiave registrata: <code>${keyToTest}</code>\n\n` +
        `📍 <b>Inserisci la via e numero civico della tua attività a Torino:</b>\n` +
        `<i>(Esempio: <code>Via Po 14</code> oppure <code>Via Roma 10</code>)</i>`
      );
      return;
    } else {
      await sendMessage(
        chatId,
        `❌ <b>Chiave non valida o inesistente.</b>\n` +
        `Assicurati di inserire la chiave univoca corretta (es: <code>TORINO-ALERT-KEY-2026</code>).`
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
      `• Invia una via torinese con civico (es: <code>Via Po 14</code>) per salvare la tua sede\n` +
      `• <code>/raggio &lt;metri&gt;</code> - Imposta il raggio di allerta personalizzato (default 150m)\n` +
      `• <code>/stazioni</code> - Elenco sensori nel tuo raggio d'azione\n` +
      `• <code>/stato</code> - Riepilogo configurazione e coordinate\n` +
      `• <code>/test_allerta</code> - Invia una simulazione di allerta`
    );
    return;
  }

  // 8. Trattamento del testo libero come INDIRIZZO DELL'ATTIVITÀ
  let addressInput = rawText;
  if (rawText.startsWith('/indirizzo')) {
    const parts = rawText.split(/\s+/);
    addressInput = parts.slice(1).join(' ').trim();
  }

  if (!addressInput) {
    await sendMessage(chatId, `⚠️ Inserisci la via e il numero civico. Esempio:\n<code>Via Po 14</code>`);
    return;
  }

  await sendMessage(chatId, `🔍 <i>Localizzazione di "${addressInput}" nel comune di Torino in corso...</i>`);

  const geocoded = await geocodeTurinAddress(addressInput);

  if (!geocoded) {
    await sendMessage(
      chatId,
      `❌ Impossibile individuare l'indirizzo torinese "${addressInput}".\nProva con un formato tipo: <code>Via Po 14</code> o <code>Piazza Castello 5</code>.`
    );
    return;
  }

  const radius = subscriber.alert_radius_meters || 150;

  upsertSubscriber({
    chat_id: chatId,
    address: geocoded.displayName,
    latitude: geocoded.lat,
    longitude: geocoded.lon,
    alert_radius_meters: radius,
  });

  // Calcola celle acustiche nel raggio parametrizzato
  const stations = getAllStationsFromDb();
  const inRange = [];

  for (const st of stations) {
    const d = calculateHaversineDistanceMeters(geocoded.lat, geocoded.lon, st.latitude, st.longitude);
    if (d <= radius) inRange.push({ st, d });
  }
  inRange.sort((a, b) => a.d - b.d);

  let stationListText = '';
  if (inRange.length > 0) {
    stationListText = `\n\n📡 <b>Celle/Sensori nel tuo raggio di ${radius}m (${inRange.length}):</b>\n` +
      inRange.map((item, i) => `${i + 1}. <b>${item.st.name}</b> [<code>${item.st.id}</code>] — a <b>${Math.round(item.d)} metri</b>`).join('\n') +
      `\n\n🔔 <i>Riceverai avvisi automatici solo da queste celle se il rumore diventa eccessivo!</i>`;
  } else {
    stationListText = `\n\nℹ️ <i>Nessun sensore rilevato entro ${radius}m. Puoi estendere il raggio con</i> <code>/raggio &lt;metri&gt;</code> (es: /raggio 300).`;
  }

  await sendMessage(
    chatId,
    `🎯 <b>Sede impostata con successo!</b>\n\n` +
    `🏢 <b>Attività:</b> ${geocoded.displayName}\n` +
    `📍 <b>Coordinate:</b> <code>${geocoded.lat.toFixed(5)}° N, ${geocoded.lon.toFixed(5)}° E</code>\n` +
    `📏 <b>Raggio configurato:</b> <b>${radius} metri</b>` +
    stationListText
  );
}

// -------------------------------------------------------------
// CICLO PRINCIPALE DI LONG-POLLING
// -------------------------------------------------------------

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
