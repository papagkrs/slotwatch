// SlotWatch-Dienst: nimmt Störungsmeldungen an, speichert sie zentral (D1)
// und benachrichtigt den Techniker per Telegram.
//
//   POST /api/meldung      neue Störung (vom Formular index.html)
//   POST /api/foto         Foto zu einer Störung nachreichen
//   POST /api/status       "Bin dran" / "Erledigt" (von erledigt.html)
//   GET  /api/uebersicht   offene Störungen + Statistik (nur mit ADMIN_KEY)

const TICKET_START = 5000;      // Ticket-Nr. = 5000 + laufende Nummer (alte Handy-Nummern begannen bei 4001)
const WARN_AB = 3;              // ab der wievielten Störung pro Gerät und Monat gewarnt wird
const MAX_PRO_ABSENDER = 10;    // Meldungen je Absender in 10 Minuten
const MAX_PRO_STANDORT = 60;    // Meldungen je Standort in 1 Stunde
const MAX_FOTO_BYTES = 10 * 1024 * 1024;
const ZEITZONE = 'Europe/Berlin';

function kopfzeilen(env, request) {
  const herkunft = request.headers.get('Origin');
  const erlaubt = (env.ERLAUBTE_HERKUNFT || '').split(',').map(s => s.trim()).filter(Boolean);
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Vary': 'Origin' };
  if (herkunft && erlaubt.includes(herkunft)) {
    h['Access-Control-Allow-Origin'] = herkunft;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, X-Admin-Key';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function text(wert, max) {
  return typeof wert === 'string' ? wert.trim().slice(0, max) : '';
}

function ortszeit(datum, was) {
  if (was === 'monat') return datum.toLocaleDateString('sv-SE', { timeZone: ZEITZONE }).slice(0, 7);
  if (was === 'datum') return datum.toLocaleDateString('de-DE', { timeZone: ZEITZONE, day: '2-digit', month: '2-digit' });
  return datum.toLocaleTimeString('de-DE', { timeZone: ZEITZONE, hour: '2-digit', minute: '2-digit' });
}

async function pruefsumme(wert) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(wert));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function zufall() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Telegram-Aufruf. Liefert immer { ok: true/false, ... } — wirft nie.
async function telegram(env, methode, daten, alsFormular) {
  try {
    const res = await fetch(`${env.TELEGRAM_API || 'https://api.telegram.org'}/bot${env.TELEGRAM_TOKEN}/${methode}`, alsFormular
      ? { method: 'POST', body: daten }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(daten) });
    const antwort = await res.json();
    return antwort && antwort.ok === true ? antwort : { ok: false, description: (antwort && antwort.description) || 'unbekannt' };
  } catch (e) {
    return { ok: false, description: 'Telegram nicht erreichbar' };
  }
}

function meldungsText(m) {
  return `🎰 NEUE STÖRUNG #${TICKET_START + m.id}\n\n📍 Standort: ${m.standort}\n🔧 Fehler: ${m.fehlertyp}\n` +
    `🎰 Automat: ${m.automat}\n👤 Gemeldet: ${m.melder}\n🕹️ Spielbar: ${m.spielbar ? '✅ Ja' : '❌ Nein'}\n` +
    (m.beschreibung ? `📝 ${m.beschreibung}\n` : '') +
    `${m.spielbar ? '🟠 MITTEL' : '🔴 KRITISCH'}\n🕐 Uhrzeit: ${ortszeit(new Date(m.erstellt), 'zeit')}`;
}

function knoepfe(env, m, nurErledigt) {
  const url = a => `${env.SEITE}/erledigt.html?id=${m.id}&k=${m.schluessel}&a=${a}`;
  const zeile = nurErledigt ? [] : [{ text: '🔧 Bin dran', url: url('dran') }];
  zeile.push({ text: '✅ Erledigt', url: url('done') });
  return { inline_keyboard: [zeile] };
}

// ---------- POST /api/meldung ----------
async function neueMeldung(request, env, antwort) {
  let d;
  try { d = await request.json(); } catch (e) { return antwort(400, { ok: false, fehler: 'eingabe', text: 'Ungültige Daten.' }); }

  const eingabe = {
    anfrage_id: text(d.anfrage_id, 64),
    standort: text(d.standort, 100),
    fehlertyp: text(d.fehlertyp, 60),
    automat: text(d.automat, 30).toUpperCase(),
    melder: text(d.melder, 60),
    beschreibung: text(d.beschreibung, 500),
  };
  if (!/^[A-Za-z0-9-]{8,64}$/.test(eingabe.anfrage_id) || !eingabe.standort || !eingabe.fehlertyp ||
      !eingabe.automat || !eingabe.melder || typeof d.spielbar !== 'boolean') {
    return antwort(400, { ok: false, fehler: 'eingabe', text: 'Bitte alle Pflichtfelder ausfüllen.' });
  }

  // Wurde genau diese Meldung schon angenommen? (zweiter Versuch nach Netzfehler, Doppelklick)
  let m = await env.DB.prepare('SELECT * FROM meldungen WHERE anfrage_id = ?').bind(eingabe.anfrage_id).first();
  if (m && m.telegram_msg_id) return antwort(200, { ok: true, ticket: TICKET_START + m.id, doppelt: true });

  if (!m) {
    const jetzt = new Date();
    const absender = await pruefsumme((request.headers.get('CF-Connecting-IP') || 'unbekannt') + '|' + env.TELEGRAM_TOKEN);

    // Bremse gegen Unfug und Fehlbedienung
    const vor10Min = new Date(jetzt - 10 * 60 * 1000).toISOString();
    const vor1Std = new Date(jetzt - 60 * 60 * 1000).toISOString();
    const jeAbsender = await env.DB.prepare('SELECT COUNT(*) AS n FROM meldungen WHERE absender = ? AND erstellt > ?').bind(absender, vor10Min).first('n');
    const jeStandort = await env.DB.prepare('SELECT COUNT(*) AS n FROM meldungen WHERE standort = ? AND erstellt > ?').bind(eingabe.standort, vor1Std).first('n');
    if (jeAbsender >= MAX_PRO_ABSENDER || jeStandort >= MAX_PRO_STANDORT) {
      return antwort(429, { ok: false, fehler: 'bremse', text: 'Zu viele Meldungen in kurzer Zeit. Bitte in ein paar Minuten nochmal versuchen.' });
    }

    await env.DB.prepare(
      `INSERT INTO meldungen (anfrage_id, schluessel, standort, fehlertyp, automat, melder, spielbar, beschreibung, monat, erstellt, absender)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(anfrage_id) DO NOTHING`
    ).bind(eingabe.anfrage_id, zufall(), eingabe.standort, eingabe.fehlertyp, eingabe.automat, eingabe.melder,
           d.spielbar ? 1 : 0, eingabe.beschreibung, ortszeit(jetzt, 'monat'), jetzt.toISOString(), absender).run();
    m = await env.DB.prepare('SELECT * FROM meldungen WHERE anfrage_id = ?').bind(eingabe.anfrage_id).first();
  }

  // Techniker benachrichtigen. Klappt das nicht, bleibt die Meldung gespeichert,
  // gilt aber als NICHT zugestellt — das Formular zeigt dann einen Fehler und versucht es mit derselben anfrage_id erneut.
  const gesendet = await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text: meldungsText(m), reply_markup: knoepfe(env, m, false) });
  if (!gesendet.ok) {
    return antwort(502, { ok: false, fehler: 'telegram', gespeichert: true, ticket: TICKET_START + m.id,
      text: 'Der Techniker konnte nicht benachrichtigt werden. Bitte nochmal absenden.' });
  }
  const zuerst = await env.DB.prepare('UPDATE meldungen SET telegram_msg_id = ? WHERE id = ? AND telegram_msg_id IS NULL')
    .bind(gesendet.result.message_id, m.id).run();

  // Wiederholungs-Warnung: 3. (oder weitere) Störung desselben Geräts im selben Monat
  if (zuerst.meta.changes === 1) {
    const anzahl = await env.DB.prepare('SELECT COUNT(*) AS n FROM meldungen WHERE betreiber = ? AND monat = ? AND standort = ? AND automat = ?')
      .bind(m.betreiber, m.monat, m.standort, m.automat).first('n');
    if (anzahl >= WARN_AB) {
      await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, reply_to_message_id: gesendet.result.message_id,
        text: `⚠️ ACHTUNG: Automat ${m.automat} (${m.standort}) hat schon ${anzahl} Störungen diesen Monat! Vielleicht genauer anschauen.` });
    }
  }
  return antwort(200, { ok: true, ticket: TICKET_START + m.id });
}

// ---------- POST /api/foto?anfrage_id=... ----------
async function foto(request, env, antwort, url) {
  const m = await env.DB.prepare('SELECT * FROM meldungen WHERE anfrage_id = ?').bind(url.searchParams.get('anfrage_id') || '').first();
  if (!m || !m.telegram_msg_id) return antwort(404, { ok: false, fehler: 'unbekannt', text: 'Meldung nicht gefunden.' });
  if (m.foto_gesendet) return antwort(200, { ok: true, doppelt: true });

  let datei;
  try { datei = (await request.formData()).get('photo'); } catch (e) { datei = null; }
  if (!datei || typeof datei === 'string' || !datei.size) return antwort(400, { ok: false, fehler: 'eingabe', text: 'Kein Foto erhalten.' });
  if (datei.size > MAX_FOTO_BYTES) return antwort(413, { ok: false, fehler: 'zu_gross', text: 'Das Foto ist zu groß.' });

  const formular = new FormData();
  formular.append('chat_id', env.TELEGRAM_CHAT_ID);
  formular.append('reply_to_message_id', String(m.telegram_msg_id));
  formular.append('caption', `📸 Foto zu Störung #${TICKET_START + m.id}`);
  formular.append('photo', datei, 'photo.jpg');
  const gesendet = await telegram(env, 'sendPhoto', formular, true);
  if (!gesendet.ok) return antwort(502, { ok: false, fehler: 'telegram', text: 'Das Foto konnte nicht gesendet werden.' });
  await env.DB.prepare('UPDATE meldungen SET foto_gesendet = 1 WHERE id = ?').bind(m.id).run();
  return antwort(200, { ok: true });
}

// ---------- POST /api/status ----------
async function status(request, env, antwort) {
  let d;
  try { d = await request.json(); } catch (e) { d = {}; }
  const id = parseInt(d.id, 10);
  const aktion = d.aktion;
  if (!id || (aktion !== 'dran' && aktion !== 'done') || typeof d.k !== 'string') {
    return antwort(400, { ok: false, fehler: 'eingabe', text: 'Link unvollständig.' });
  }
  const m = await env.DB.prepare('SELECT * FROM meldungen WHERE id = ? AND schluessel = ?').bind(id, d.k).first();
  if (!m) return antwort(404, { ok: false, fehler: 'unbekannt', text: 'Diese Störung gibt es nicht (mehr).' });

  const jetzt = new Date();
  // Nur wer den Status wirklich ändert, schreibt in den Chat — so gibt es auch
  // bei zwei Technikern auf zwei Handys keine doppelte Nachricht.
  const geaendert = aktion === 'done'
    ? await env.DB.prepare("UPDATE meldungen SET status = 'erledigt', erledigt_am = ? WHERE id = ? AND status != 'erledigt'").bind(jetzt.toISOString(), id).run()
    : await env.DB.prepare("UPDATE meldungen SET status = 'in_arbeit', dran_am = ? WHERE id = ? AND status = 'offen'").bind(jetzt.toISOString(), id).run();
  const ticket = TICKET_START + m.id;
  if (geaendert.meta.changes !== 1) {
    const aktuell = await env.DB.prepare('SELECT status FROM meldungen WHERE id = ?').bind(id).first('status');
    return antwort(200, { ok: true, schon: true, status: aktuell, ticket });
  }

  const stempel = `Störung #${ticket}, Automat ${m.automat} (${ortszeit(jetzt, 'zeit')}, ${ortszeit(jetzt, 'datum')})`;
  const chat = await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, reply_to_message_id: m.telegram_msg_id,
    text: (aktion === 'done' ? '✅ ERLEDIGT — ' : '🔧 BIN DRAN — ') + stempel });
  if (m.telegram_msg_id) {
    await telegram(env, 'editMessageReplyMarkup', { chat_id: env.TELEGRAM_CHAT_ID, message_id: m.telegram_msg_id,
      reply_markup: aktion === 'done' ? { inline_keyboard: [] } : knoepfe(env, m, true) });
  }
  return antwort(200, { ok: true, status: aktion === 'done' ? 'erledigt' : 'in_arbeit', ticket, chat: chat.ok });
}

// ---------- GET /api/uebersicht ----------
async function uebersicht(request, env, antwort) {
  if (!env.ADMIN_KEY) return antwort(503, { ok: false, fehler: 'nicht_eingerichtet', text: 'Die Übersicht ist noch nicht eingerichtet.' });
  if (request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) return antwort(401, { ok: false, fehler: 'kennwort', text: 'Falsches Kennwort.' });

  const felder = `id + ${TICKET_START} AS ticket, standort, fehlertyp, automat, melder, spielbar, beschreibung, status, erstellt, dran_am, erledigt_am,
                  CASE WHEN telegram_msg_id IS NULL THEN 0 ELSE 1 END AS zugestellt`;
  const monat = ortszeit(new Date(), 'monat');
  const [offen, erledigt, geraete, standorte] = await Promise.all([
    env.DB.prepare(`SELECT ${felder} FROM meldungen WHERE betreiber = 'eigen' AND status != 'erledigt' ORDER BY spielbar ASC, erstellt ASC LIMIT 200`).all(),
    env.DB.prepare(`SELECT ${felder} FROM meldungen WHERE betreiber = 'eigen' AND status = 'erledigt' ORDER BY erledigt_am DESC LIMIT 30`).all(),
    env.DB.prepare(`SELECT standort, automat, COUNT(*) AS anzahl FROM meldungen WHERE betreiber = 'eigen' AND monat = ?
                    GROUP BY standort, automat ORDER BY anzahl DESC, standort, automat LIMIT 30`).bind(monat).all(),
    env.DB.prepare(`SELECT standort, COUNT(*) AS anzahl FROM meldungen WHERE betreiber = 'eigen' AND monat = ?
                    GROUP BY standort ORDER BY anzahl DESC, standort`).bind(monat).all(),
  ]);
  return antwort(200, { ok: true, monat, offen: offen.results, erledigt: erledigt.results, geraete: geraete.results, standorte: standorte.results });
}

export default {
  async fetch(request, env) {
    const h = kopfzeilen(env, request);
    const antwort = (code, daten) => new Response(JSON.stringify(daten), { status: code, headers: h });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });

    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/api/meldung') return await neueMeldung(request, env, antwort);
      if (request.method === 'POST' && url.pathname === '/api/foto') return await foto(request, env, antwort, url);
      if (request.method === 'POST' && url.pathname === '/api/status') return await status(request, env, antwort);
      if (request.method === 'GET' && url.pathname === '/api/uebersicht') return await uebersicht(request, env, antwort);
      return antwort(404, { ok: false, fehler: 'unbekannt', text: 'Nicht gefunden.' });
    } catch (e) {
      console.error('SlotWatch-Fehler:', e && e.message);
      return antwort(500, { ok: false, fehler: 'intern', text: 'Interner Fehler. Bitte nochmal versuchen.' });
    }
  }
};
