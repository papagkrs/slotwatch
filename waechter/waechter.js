// SlotWatch Wächter — läuft alle 5 Minuten über GitHub Actions (kostenlos, kein Server).
// Aufgaben:
//   1. Schaut, ob in Telegram "🔧 Bin dran" oder "✅ Erledigt" gedrückt wurde
//      und schreibt den Status sichtbar in die Störungs-Nachricht.
//   2. Führt das Logbuch waechter/meldungen.json.
//   3. Warnt, wenn dasselbe Gerät zum 3. Mal im Monat gemeldet wird.
// Test ohne echtes Telegram: TEST_UPDATES=testdaten.json node waechter.js

const fs = require('fs');
const path = require('path');

const WARN_AB = 3; // ab der wievielten Störung pro Monat gewarnt wird

// Token + Chat-ID direkt aus index.html lesen — so gibt es nur EINE Stelle,
// die bei einem Token-Wechsel (@BotFather) geändert werden muss.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const token = (html.match(/api\.telegram\.org\/bot([0-9]+:[A-Za-z0-9_-]+)\//) || [])[1];
const chatId = (html.match(/chat_id:\s*'(-?\d+)'/) || [])[1];
if (!token || !chatId) { console.error('FEHLER: Token/Chat-ID nicht in index.html gefunden'); process.exit(1); }

const LOG_DATEI = path.join(__dirname, 'meldungen.json');
const TEST = process.env.TEST_UPDATES; // Testmodus: keine echten Telegram-Aufrufe

async function api(methode, daten) {
  if (TEST) { console.log('[TEST] wuerde senden:', methode, JSON.stringify(daten)); return { ok: true, result: [] }; }
  const res = await fetch(`https://api.telegram.org/bot${token}/${methode}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(daten)
  });
  return res.json();
}

// Uhrzeit/Datum in deutscher Zeitzone (GitHub-Server laufen in UTC)
function jetzt(format) {
  const opt = { timeZone: 'Europe/Vienna' };
  if (format === 'zeit') return new Date().toLocaleTimeString('de-AT', { ...opt, hour: '2-digit', minute: '2-digit' });
  if (format === 'datum') return new Date().toLocaleDateString('de-AT', { ...opt, day: '2-digit', month: '2-digit' });
  return new Date().toLocaleDateString('sv-SE', opt).slice(0, 7); // Monat, z.B. "2026-08"
}

function ladeLog() {
  try { return JSON.parse(fs.readFileSync(LOG_DATEI, 'utf8')); } catch (e) { return []; }
}

// Gerät + Standort + Ticket-Nr. aus dem Nachrichtentext herauslesen
function parseNachricht(text) {
  return {
    ticket: (text.match(/#(\d+)/) || [])[1] || '?',
    automat: ((text.match(/🎰 Automat: (.+)/) || [])[1] || 'unbekannt').trim().toUpperCase(),
    standort: ((text.match(/📍 Standort: (.+)/) || [])[1] || 'unbekannt').trim()
  };
}

async function main() {
  const log = ladeLog();
  let geaendert = false;

  let updates;
  if (TEST) {
    updates = { ok: true, result: JSON.parse(fs.readFileSync(path.join(__dirname, TEST), 'utf8')) };
  } else {
    updates = await api('getUpdates', { timeout: 0, allowed_updates: ['callback_query'] });
  }
  if (!updates.ok) { console.error('getUpdates fehlgeschlagen:', JSON.stringify(updates)); process.exit(1); }
  console.log(`${updates.result.length} neue Ereignisse`);

  let letzteUpdateId = null;

  for (const u of updates.result) {
    letzteUpdateId = u.update_id;
    const cb = u.callback_query;
    if (!cb || !cb.message || !cb.message.text) continue;
    if (cb.data !== 'dran' && cb.data !== 'done') continue;

    const msg = cb.message;
    const wer = cb.from.first_name || 'Techniker';
    const info = parseNachricht(msg.text);

    // Antwort auf den Knopfdruck (nach Minuten meist abgelaufen — Fehler egal)
    await api('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});

    // Logbuch-Eintrag suchen oder neu anlegen (eine Nachricht = eine Störung)
    let eintrag = log.find(e => e.message_id === msg.message_id);
    const neu = !eintrag;
    if (neu) {
      eintrag = { message_id: msg.message_id, ticket: info.ticket, automat: info.automat,
                  standort: info.standort, monat: jetzt('monat'), status: 'offen', warnung_gesendet: false };
      log.push(eintrag);
      geaendert = true;
    }
    if (eintrag.status === 'erledigt') continue; // doppelter Klick — nichts mehr tun

    const stempel = `${wer} (${jetzt('zeit')}, ${jetzt('datum')})`;
    if (cb.data === 'dran' && eintrag.status === 'offen') {
      eintrag.status = 'in_arbeit';
      eintrag.dran = stempel;
      geaendert = true;
      await api('editMessageText', {
        chat_id: msg.chat.id, message_id: msg.message_id,
        text: msg.text + `\n\n🔧 BIN DRAN — ${stempel}`,
        reply_markup: { inline_keyboard: [[{ text: '✅ Erledigt', callback_data: 'done' }]] }
      });
    } else if (cb.data === 'done') {
      eintrag.status = 'erledigt';
      eintrag.erledigt = stempel;
      geaendert = true;
      await api('editMessageText', {
        chat_id: msg.chat.id, message_id: msg.message_id,
        text: msg.text + `\n\n✅ ERLEDIGT — ${stempel}`
      });
    }

    // Wiederholungs-Warnung: 3. Störung desselben Geräts im selben Monat
    if (!eintrag.warnung_gesendet) {
      const anzahl = log.filter(e => e.automat === eintrag.automat && e.standort === eintrag.standort
                                  && e.monat === eintrag.monat).length;
      if (anzahl >= WARN_AB && eintrag.automat !== 'UNBEKANNT') {
        eintrag.warnung_gesendet = true;
        await api('sendMessage', {
          chat_id: msg.chat.id, reply_to_message_id: msg.message_id,
          text: `⚠️ ACHTUNG: Automat ${eintrag.automat} (${eintrag.standort}) hat schon ${anzahl} Störungen diesen Monat! Vielleicht genauer anschauen.`
        });
      }
    }
  }

  // Verarbeitete Ereignisse bei Telegram bestätigen, sonst kommen sie immer wieder
  if (!TEST && letzteUpdateId !== null) {
    await api('getUpdates', { offset: letzteUpdateId + 1, limit: 1, timeout: 0, allowed_updates: ['callback_query'] });
  }

  if (geaendert) {
    fs.writeFileSync(LOG_DATEI, JSON.stringify(log, null, 2) + '\n');
    console.log('Logbuch aktualisiert:', LOG_DATEI);
  } else {
    console.log('Nichts zu tun.');
  }
}

main().catch(e => { console.error('FEHLER:', e); process.exit(1); });
