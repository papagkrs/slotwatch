// SlotWatch-Dienst: nimmt Störungsmeldungen an, speichert sie zentral (D1)
// und benachrichtigt den Techniker per Telegram.
//
// Für alle (Meldeformular, Telegram-Knöpfe):
//   POST /api/meldung              neue Störung
//   GET  /api/meldung?anfrage_id=  Stand der eigenen Meldung (für die Erfolgsseite)
//   POST /api/foto?anfrage_id=     Foto nachreichen (wird nur weitergereicht, nicht gespeichert)
//   POST /api/status               "Bin dran" / "Erledigt"
// Nur mit Kennwort (Kopfzeile X-Admin-Key, Betreiber über ?b=...):
//   GET  /api/uebersicht           offene Störungen + Statistik
//   GET  /api/export               alle Störungen als Sicherung
//   GET  /api/standorte            Standort-Liste
//   POST /api/standorte            Standort anlegen / ein- und ausschalten
// Nur mit dem Haupt-Kennwort (ADMIN_KEY):
//   GET  /api/betreiber            weitere Betreiber auflisten
//   POST /api/betreiber            weiteren Betreiber anlegen
// Zeitgesteuert (alle 30 Minuten): Erinnerung an offene Störungen, Namen nach Frist entfernen.

const TICKET_START = 5000;      // Ticket-Nr. = 5000 + laufende Nummer (alte Handy-Nummern begannen bei 4001)
const WARN_AB = 3;              // ab der wievielten Störung pro Gerät und Monat gewarnt wird
const MAX_PRO_ABSENDER = 10;    // Meldungen je Absender in 10 Minuten
const MAX_PRO_STANDORT = 60;    // Meldungen je Standort in 1 Stunde
const MAX_FEHLVERSUCHE = 10;    // falsche Kennwörter je Absender in 10 Minuten
const MAX_FOTO_BYTES = 10 * 1024 * 1024;
const ZEITZONE = 'Europe/Berlin';
const EIGEN = 'eigen';          // die eigenen Hallen; ihre Einstellungen stehen in wrangler.toml / den Geheimnissen

// ---------- Hilfen ----------
function kopfzeilen(env, request) {
  const herkunft = request.headers.get('Origin');
  const erlaubt = (env.ERLAUBTE_HERKUNFT || '').split(',').map(s => s.trim()).filter(Boolean);
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Vary': 'Origin', 'Cache-Control': 'no-store' };
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

function zahl(wert, ersatz) {
  const n = parseFloat(wert);
  return Number.isFinite(n) && n >= 0 ? n : ersatz;
}

function ortszeit(datum, was) {
  if (was === 'monat') return datum.toLocaleDateString('sv-SE', { timeZone: ZEITZONE }).slice(0, 7);
  if (was === 'datum') return datum.toLocaleDateString('de-DE', { timeZone: ZEITZONE, day: '2-digit', month: '2-digit' });
  return datum.toLocaleTimeString('de-DE', { timeZone: ZEITZONE, hour: '2-digit', minute: '2-digit' });
}

async function pruefsumme(wert) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(wert));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function zufall(bytes = 16) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function absenderVon(request, env) {
  return (await pruefsumme((request.headers.get('CF-Connecting-IP') || 'unbekannt') + '|' + env.TELEGRAM_TOKEN)).slice(0, 32);
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

// Betreiber nachschlagen: liefert { slug, name, chat } oder null (unbekannt / abgeschaltet).
async function betreiberVon(env, slugRoh) {
  const slug = text(slugRoh, 40).toLowerCase() || EIGEN;
  if (slug === EIGEN) return { slug: EIGEN, name: 'Eigene Hallen', chat: env.TELEGRAM_CHAT_ID };
  if (!/^[a-z0-9-]{2,40}$/.test(slug)) return null;
  const b = await env.DB.prepare('SELECT * FROM betreiber WHERE slug = ? AND aktiv = 1').bind(slug).first();
  return b ? { slug: b.slug, name: b.name, chat: b.telegram_chat_id, admin_pruefsumme: b.admin_pruefsumme } : null;
}

async function chatVon(env, slug) {
  const b = await betreiberVon(env, slug);
  return b ? b.chat : null;
}

// Kennwort prüfen. Liefert { betreiber } oder { fehler: fertige Antwort }.
// nurHaupt = true: nur das Haupt-Kennwort (ADMIN_KEY) zählt.
async function anmeldung(request, env, antwort, url, nurHaupt) {
  if (!env.ADMIN_KEY) return { fehler: antwort(503, { ok: false, fehler: 'nicht_eingerichtet', text: 'Der Verwaltungs-Zugang ist noch nicht eingerichtet (Kennwort fehlt).' }) };
  const absender = await absenderVon(request, env);
  const vor10Min = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const versuche = await env.DB.prepare('SELECT COUNT(*) AS n FROM fehlversuche WHERE absender = ? AND zeit > ?').bind(absender, vor10Min).first('n');
  if (versuche >= MAX_FEHLVERSUCHE) return { fehler: antwort(429, { ok: false, fehler: 'bremse', text: 'Zu viele falsche Kennwörter. Bitte in 10 Minuten nochmal versuchen.' }) };

  const kennwort = request.headers.get('X-Admin-Key') || '';
  const betreiber = nurHaupt ? await betreiberVon(env, EIGEN) : await betreiberVon(env, url.searchParams.get('b'));
  let richtig = false;
  if (betreiber && kennwort) {
    const soll = betreiber.slug === EIGEN ? await pruefsumme('sw|' + env.ADMIN_KEY) : betreiber.admin_pruefsumme;
    richtig = (await pruefsumme('sw|' + kennwort)) === soll;
  }
  if (!richtig) {
    await env.DB.prepare('INSERT INTO fehlversuche (absender, zeit) VALUES (?, ?)').bind(absender, new Date().toISOString()).run();
    return { fehler: antwort(401, { ok: false, fehler: 'kennwort', text: 'Falsches Kennwort.' }) };
  }
  return { betreiber };
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
  const betreiber = await betreiberVon(env, d.betreiber);
  if (!betreiber) return antwort(404, { ok: false, fehler: 'betreiber', text: 'Dieser QR-Code ist nicht (mehr) gültig.' });

  // Wurde genau diese Meldung schon angenommen? (zweiter Versuch nach Netzfehler, Doppelklick)
  let m = await env.DB.prepare('SELECT * FROM meldungen WHERE anfrage_id = ?').bind(eingabe.anfrage_id).first();
  if (m && m.telegram_msg_id) return antwort(200, { ok: true, ticket: TICKET_START + m.id, doppelt: true });

  if (!m) {
    const jetzt = new Date();
    const absender = await absenderVon(request, env);

    // Bremse gegen Unfug und Fehlbedienung
    const vor10Min = new Date(jetzt - 10 * 60 * 1000).toISOString();
    const vor1Std = new Date(jetzt - 60 * 60 * 1000).toISOString();
    const jeAbsender = await env.DB.prepare('SELECT COUNT(*) AS n FROM meldungen WHERE absender = ? AND erstellt > ?').bind(absender, vor10Min).first('n');
    const jeStandort = await env.DB.prepare('SELECT COUNT(*) AS n FROM meldungen WHERE betreiber = ? AND standort = ? AND erstellt > ?')
      .bind(betreiber.slug, eingabe.standort, vor1Std).first('n');
    if (jeAbsender >= MAX_PRO_ABSENDER || jeStandort >= MAX_PRO_STANDORT) {
      return antwort(429, { ok: false, fehler: 'bremse', text: 'Zu viele Meldungen in kurzer Zeit. Bitte in ein paar Minuten nochmal versuchen.' });
    }

    // Steht der Standort in der Liste? Unbekannte werden angenommen, aber in der Übersicht markiert.
    const bekannt = await env.DB.prepare('SELECT COUNT(*) AS n FROM standorte WHERE betreiber = ? AND name = ? AND aktiv = 1')
      .bind(betreiber.slug, eingabe.standort).first('n');

    await env.DB.prepare(
      `INSERT INTO meldungen (betreiber, anfrage_id, schluessel, standort, fehlertyp, automat, melder, spielbar, beschreibung, monat, erstellt, absender, standort_bekannt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(anfrage_id) DO NOTHING`
    ).bind(betreiber.slug, eingabe.anfrage_id, zufall(), eingabe.standort, eingabe.fehlertyp, eingabe.automat, eingabe.melder,
           d.spielbar ? 1 : 0, eingabe.beschreibung, ortszeit(jetzt, 'monat'), jetzt.toISOString(), absender, bekannt ? 1 : 0).run();
    m = await env.DB.prepare('SELECT * FROM meldungen WHERE anfrage_id = ?').bind(eingabe.anfrage_id).first();
  }

  // Techniker benachrichtigen. Klappt das nicht, bleibt die Meldung gespeichert,
  // gilt aber als NICHT zugestellt — das Formular zeigt dann einen Fehler und versucht es mit derselben anfrage_id erneut.
  const chat = await chatVon(env, m.betreiber);
  const gesendet = chat ? await telegram(env, 'sendMessage', { chat_id: chat, text: meldungsText(m), reply_markup: knoepfe(env, m, false) }) : { ok: false };
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
      await telegram(env, 'sendMessage', { chat_id: chat, reply_to_message_id: gesendet.result.message_id,
        text: `⚠️ ACHTUNG: Automat ${m.automat} (${m.standort}) hat schon ${anzahl} Störungen diesen Monat! Vielleicht genauer anschauen.` });
    }
  }
  return antwort(200, { ok: true, ticket: TICKET_START + m.id });
}

// ---------- GET /api/meldung?anfrage_id=... ----------
// Für die Erfolgsseite des Melders: nur Stand und Zeiten, keine Namen und keine Schlüssel.
async function standDerMeldung(env, antwort, url) {
  const m = await env.DB.prepare('SELECT id, status, erstellt, dran_am, erledigt_am, telegram_msg_id FROM meldungen WHERE anfrage_id = ?')
    .bind(url.searchParams.get('anfrage_id') || '').first();
  if (!m) return antwort(404, { ok: false, fehler: 'unbekannt', text: 'Meldung nicht gefunden.' });
  return antwort(200, { ok: true, ticket: TICKET_START + m.id, status: m.status, zugestellt: m.telegram_msg_id ? true : false,
    erstellt: m.erstellt, dran_am: m.dran_am, erledigt_am: m.erledigt_am });
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
  formular.append('chat_id', await chatVon(env, m.betreiber) || '');
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
  const wer = text(d.wer, 40);
  // Nur wer den Status wirklich ändert, schreibt in den Chat — so gibt es auch
  // bei zwei Technikern auf zwei Handys keine doppelte Nachricht.
  const geaendert = aktion === 'done'
    ? await env.DB.prepare("UPDATE meldungen SET status = 'erledigt', erledigt_am = ?, erledigt_von = ? WHERE id = ? AND status != 'erledigt'").bind(jetzt.toISOString(), wer, id).run()
    : await env.DB.prepare("UPDATE meldungen SET status = 'in_arbeit', dran_am = ?, dran_von = ? WHERE id = ? AND status = 'offen'").bind(jetzt.toISOString(), wer, id).run();
  const ticket = TICKET_START + m.id;
  if (geaendert.meta.changes !== 1) {
    const aktuell = await env.DB.prepare('SELECT status FROM meldungen WHERE id = ?').bind(id).first('status');
    return antwort(200, { ok: true, schon: true, status: aktuell, ticket });
  }

  const chatId = await chatVon(env, m.betreiber);
  const stempel = `${wer ? wer + ' — ' : ''}Störung #${ticket}, Automat ${m.automat} (${ortszeit(jetzt, 'zeit')}, ${ortszeit(jetzt, 'datum')})`;
  const chat = await telegram(env, 'sendMessage', { chat_id: chatId, reply_to_message_id: m.telegram_msg_id,
    text: (aktion === 'done' ? '✅ ERLEDIGT — ' : '🔧 BIN DRAN — ') + stempel });
  if (m.telegram_msg_id) {
    await telegram(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: m.telegram_msg_id,
      reply_markup: aktion === 'done' ? { inline_keyboard: [] } : knoepfe(env, m, true) });
  }
  return antwort(200, { ok: true, status: aktion === 'done' ? 'erledigt' : 'in_arbeit', ticket, chat: chat.ok });
}

// ---------- GET /api/uebersicht ----------
const FELDER = `id + ${TICKET_START} AS ticket, standort, fehlertyp, automat, melder, spielbar, beschreibung, status, erstellt,
                dran_am, dran_von, erledigt_am, erledigt_von, erinnert_am, standort_bekannt, foto_gesendet,
                CASE WHEN telegram_msg_id IS NULL THEN 0 ELSE 1 END AS zugestellt`;
const MINUTEN = (bis) => `ROUND(AVG((julianday(${bis}) - julianday(erstellt)) * 24 * 60))`;

async function uebersicht(env, antwort, betreiber) {
  const monat = ortszeit(new Date(), 'monat');
  const b = betreiber.slug;
  const [offen, erledigt, geraete, standorte, dauer] = await Promise.all([
    env.DB.prepare(`SELECT ${FELDER} FROM meldungen WHERE betreiber = ? AND status != 'erledigt' ORDER BY spielbar ASC, erstellt ASC LIMIT 200`).bind(b).all(),
    env.DB.prepare(`SELECT ${FELDER} FROM meldungen WHERE betreiber = ? AND status = 'erledigt' ORDER BY erledigt_am DESC LIMIT 30`).bind(b).all(),
    env.DB.prepare(`SELECT standort, automat, COUNT(*) AS anzahl FROM meldungen WHERE betreiber = ? AND monat = ?
                    GROUP BY standort, automat ORDER BY anzahl DESC, standort, automat LIMIT 30`).bind(b, monat).all(),
    env.DB.prepare(`SELECT standort, COUNT(*) AS anzahl, ${MINUTEN('erledigt_am')} AS reparatur_min FROM meldungen WHERE betreiber = ? AND monat = ?
                    GROUP BY standort ORDER BY anzahl DESC, standort`).bind(b, monat).all(),
    env.DB.prepare(`SELECT COUNT(erledigt_am) AS erledigt, ${MINUTEN('dran_am')} AS reaktion_min, ${MINUTEN('erledigt_am')} AS reparatur_min
                    FROM meldungen WHERE betreiber = ? AND monat = ?`).bind(b, monat).first(),
  ]);
  return antwort(200, { ok: true, betreiber: betreiber.name, monat, offen: offen.results, erledigt: erledigt.results,
    geraete: geraete.results, standorte: standorte.results, dauer });
}

// ---------- GET /api/export ----------
async function exportieren(env, antwort, betreiber) {
  const alle = await env.DB.prepare(`SELECT ${FELDER}, monat, anonymisiert_am FROM meldungen WHERE betreiber = ? ORDER BY id`).bind(betreiber.slug).all();
  const orte = await env.DB.prepare('SELECT name, aktiv, erstellt FROM standorte WHERE betreiber = ? ORDER BY name').bind(betreiber.slug).all();
  return antwort(200, { ok: true, betreiber: betreiber.slug, erstellt: new Date().toISOString(), meldungen: alle.results, standorte: orte.results });
}

// ---------- /api/standorte ----------
async function standorteLesen(env, antwort, betreiber) {
  const orte = await env.DB.prepare('SELECT name, aktiv FROM standorte WHERE betreiber = ? ORDER BY aktiv DESC, name').bind(betreiber.slug).all();
  return antwort(200, { ok: true, betreiber: betreiber.slug, standorte: orte.results });
}

async function standortSetzen(request, env, antwort, betreiber) {
  let d;
  try { d = await request.json(); } catch (e) { d = {}; }
  const name = text(d.name, 100);
  if (!name) return antwort(400, { ok: false, fehler: 'eingabe', text: 'Bitte einen Namen eingeben.' });
  const aktiv = d.aktiv === false ? 0 : 1;
  await env.DB.prepare(`INSERT INTO standorte (betreiber, name, aktiv, erstellt) VALUES (?, ?, ?, ?)
                        ON CONFLICT(betreiber, name) DO UPDATE SET aktiv = excluded.aktiv`)
    .bind(betreiber.slug, name, aktiv, new Date().toISOString()).run();
  return standorteLesen(env, antwort, betreiber);
}

// ---------- /api/betreiber (nur Haupt-Kennwort) ----------
async function betreiberLesen(env, antwort) {
  const alle = await env.DB.prepare('SELECT slug, name, telegram_chat_id, aktiv, erstellt FROM betreiber ORDER BY slug').all();
  return antwort(200, { ok: true, betreiber: alle.results });
}

async function betreiberAnlegen(request, env, antwort) {
  let d;
  try { d = await request.json(); } catch (e) { d = {}; }
  const slug = text(d.slug, 40).toLowerCase();
  const name = text(d.name, 80);
  const chat = text(String(d.telegram_chat_id === undefined ? '' : d.telegram_chat_id), 30);
  if (!/^[a-z0-9-]{2,40}$/.test(slug) || slug === EIGEN || !name || !/^-?\d{4,20}$/.test(chat)) {
    return antwort(400, { ok: false, fehler: 'eingabe', text: 'Kurzname (Kleinbuchstaben, Ziffern, Bindestrich), Name und Telegram-Chat-Nummer werden gebraucht.' });
  }
  // Abschalten / wieder einschalten eines vorhandenen Betreibers
  if (typeof d.aktiv === 'boolean' && await env.DB.prepare('SELECT 1 AS da FROM betreiber WHERE slug = ?').bind(slug).first('da')) {
    await env.DB.prepare('UPDATE betreiber SET aktiv = ?, name = ?, telegram_chat_id = ? WHERE slug = ?').bind(d.aktiv ? 1 : 0, name, chat, slug).run();
    return betreiberLesen(env, antwort);
  }
  const kennwort = zufall(12);   // wird genau EINMAL zurückgegeben, gespeichert wird nur die Prüfsumme
  const neu = await env.DB.prepare('INSERT INTO betreiber (slug, name, telegram_chat_id, admin_pruefsumme, aktiv, erstellt) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(slug) DO NOTHING')
    .bind(slug, name, chat, await pruefsumme('sw|' + kennwort), new Date().toISOString()).run();
  if (neu.meta.changes !== 1) return antwort(409, { ok: false, fehler: 'vorhanden', text: 'Diesen Kurznamen gibt es schon.' });
  return antwort(200, { ok: true, slug, kennwort, hinweis: 'Dieses Kennwort wird nur jetzt angezeigt.' });
}

// ---------- Zeitgesteuert ----------
// 1. Erinnerung: Störung ist benachrichtigt, aber noch niemand hat "Bin dran" gedrückt. Je Störung genau 1 Erinnerung.
// 2. Datenschutz: nach der Aufbewahrungsfrist Namen und Freitext entfernen (die Statistik bleibt).
async function zeitlauf(env, jetzt = new Date()) {
  const ergebnis = { erinnert: 0, anonymisiert: 0 };
  const stdKritisch = zahl(env.ERINNERUNG_KRITISCH_STD, 2);   // nicht spielbar
  const stdNormal = zahl(env.ERINNERUNG_NORMAL_STD, 24);     // spielbar;  0 = keine Erinnerung
  const grenze = std => new Date(jetzt - std * 60 * 60 * 1000).toISOString();
  const faellig = await env.DB.prepare(
    `SELECT * FROM meldungen WHERE status = 'offen' AND erinnert_am IS NULL AND telegram_msg_id IS NOT NULL
       AND ((spielbar = 0 AND ? > 0 AND erstellt < ?) OR (spielbar = 1 AND ? > 0 AND erstellt < ?)) ORDER BY erstellt LIMIT 20`
  ).bind(stdKritisch, grenze(stdKritisch), stdNormal, grenze(stdNormal)).all();
  for (const m of faellig.results) {
    const chat = await chatVon(env, m.betreiber);
    if (!chat) continue;
    const stunden = Math.floor((jetzt - new Date(m.erstellt)) / (60 * 60 * 1000));
    const gesendet = await telegram(env, 'sendMessage', { chat_id: chat, reply_to_message_id: m.telegram_msg_id,
      text: `⏰ ERINNERUNG: Störung #${TICKET_START + m.id} (Automat ${m.automat}, ${m.standort}) ist seit ${stunden} Std. offen — noch niemand dran.` });
    if (gesendet.ok) {
      await env.DB.prepare('UPDATE meldungen SET erinnert_am = ? WHERE id = ? AND erinnert_am IS NULL').bind(jetzt.toISOString(), m.id).run();
      ergebnis.erinnert++;
    }
  }

  const monate = zahl(env.AUFBEWAHRUNG_MONATE, 12);            // 0 = nie entfernen
  if (monate > 0) {
    const alt = new Date(jetzt);
    alt.setMonth(alt.getMonth() - monate);
    const r = await env.DB.prepare(
      `UPDATE meldungen SET melder = '', beschreibung = '', dran_von = '', erledigt_von = '', anonymisiert_am = ?
       WHERE anonymisiert_am IS NULL AND erstellt < ?`).bind(jetzt.toISOString(), alt.toISOString()).run();
    ergebnis.anonymisiert = r.meta.changes;
  }
  await env.DB.prepare('DELETE FROM fehlversuche WHERE zeit < ?').bind(grenze(24)).run();
  return ergebnis;
}

export default {
  async fetch(request, env) {
    const h = kopfzeilen(env, request);
    const antwort = (code, daten) => new Response(JSON.stringify(daten), { status: code, headers: h });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });

    const url = new URL(request.url);
    const weg = request.method + ' ' + url.pathname;
    try {
      if (weg === 'POST /api/meldung') return await neueMeldung(request, env, antwort);
      if (weg === 'GET /api/meldung') return await standDerMeldung(env, antwort, url);
      if (weg === 'POST /api/foto') return await foto(request, env, antwort, url);
      if (weg === 'POST /api/status') return await status(request, env, antwort);

      const verwaltung = { 'GET /api/uebersicht': uebersicht, 'GET /api/export': exportieren, 'GET /api/standorte': standorteLesen };
      if (verwaltung[weg] || weg === 'POST /api/standorte') {
        const a = await anmeldung(request, env, antwort, url, false);
        if (a.fehler) return a.fehler;
        return weg === 'POST /api/standorte' ? await standortSetzen(request, env, antwort, a.betreiber) : await verwaltung[weg](env, antwort, a.betreiber);
      }
      if (weg === 'GET /api/betreiber' || weg === 'POST /api/betreiber') {
        const a = await anmeldung(request, env, antwort, url, true);
        if (a.fehler) return a.fehler;
        return weg === 'GET /api/betreiber' ? await betreiberLesen(env, antwort) : await betreiberAnlegen(request, env, antwort);
      }
      return antwort(404, { ok: false, fehler: 'unbekannt', text: 'Nicht gefunden.' });
    } catch (e) {
      console.error('SlotWatch-Fehler:', e && e.message);
      return antwort(500, { ok: false, fehler: 'intern', text: 'Interner Fehler. Bitte nochmal versuchen.' });
    }
  },

  async scheduled(ereignis, env, ctx) {
    ctx.waitUntil(zeitlauf(env).then(e => console.log('SlotWatch-Zeitlauf:', JSON.stringify(e))));
  },

  zeitlauf   // für die Tests direkt aufrufbar
};
