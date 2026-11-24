// Tests für den SlotWatch-Dienst.
// ECHT: die Datenbank (lokale Cloudflare-D1 über wrangler) und der komplette Dienst-Code.
// ERSETZT: Telegram — es geht KEINE Nachricht raus (globalThis.fetch ist abgefangen).
// Start: cd worker && npm install && npm test
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';
import dienst from '../src/index.js';

let proxy, env;
let telegram = [];          // abgefangene Telegram-Aufrufe
let telegramKaputt = false; // true = Telegram antwortet mit Fehler
let ip = '10.0.0.1';
const echtesFetch = globalThis.fetch;

before(async () => {
  proxy = await getPlatformProxy({ configPath: new URL('../wrangler.toml', import.meta.url).pathname, persist: false });
  env = { ...proxy.env, TELEGRAM_TOKEN: 'TEST:token', ADMIN_KEY: 'geheim' };
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
  for (const befehl of schema.split(';').map(s => s.trim()).filter(Boolean)) await env.DB.prepare(befehl).run();
  globalThis.fetch = async (url, opt) => {
    const u = String(url);
    if (!u.startsWith('https://api.telegram.org/')) throw new Error('Unerwarteter Netz-Aufruf im Test: ' + u);
    const methode = u.split('/').pop();
    const daten = typeof opt.body === 'string' ? JSON.parse(opt.body) : Object.fromEntries([...opt.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '<datei>']));
    telegram.push({ methode, daten });
    if (telegramKaputt) return new Response(JSON.stringify({ ok: false, description: 'Too Many Requests' }), { status: 429 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 900 + telegram.length } }));
  };
});
after(async () => { globalThis.fetch = echtesFetch; await proxy.dispose(); });
beforeEach(async () => { telegram = []; telegramKaputt = false; ip = '10.0.0.1'; for (const t of ['meldungen', 'standorte', 'betreiber', 'fehlversuche']) await env.DB.prepare('DELETE FROM ' + t).run(); });

let zaehler = 0;
const meldung = (mehr = {}) => ({ anfrage_id: 'anfrage-' + String(++zaehler).padStart(6, '0'), standort: 'Halle Test', fehlertyp: 'Alarm',
  automat: 'a-07', melder: 'Maria', spielbar: true, beschreibung: '', ...mehr });

async function ruf(methode, pfad, body, kopf = {}) {
  const init = { method: methode, headers: { 'CF-Connecting-IP': ip, 'Origin': 'https://papagkrs.github.io', ...kopf } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const res = await dienst.fetch(new Request('https://slotwatch.example' + pfad, init), env);
  return { code: res.status, kopf: res.headers, daten: res.status === 204 ? null : await res.json() };
}
const zeilen = async () => (await env.DB.prepare('SELECT * FROM meldungen ORDER BY id').all()).results;
const gesendet = methode => telegram.filter(t => t.methode === methode);

test('Meldung wird gespeichert und der Techniker genau 1x benachrichtigt', async () => {
  const r = await ruf('POST', '/api/meldung', meldung({ spielbar: false, beschreibung: 'seit heute früh' }));
  assert.equal(r.code, 200);
  const z = await zeilen();
  assert.equal(z.length, 1);
  assert.equal(r.daten.ticket, 5000 + z[0].id);
  assert.equal(z[0].automat, 'A-07');
  assert.equal(z[0].status, 'offen');
  assert.ok(z[0].telegram_msg_id, 'Zustellung ist vermerkt');
  assert.equal(telegram.length, 1);
  const t = telegram[0].daten;
  assert.equal(t.chat_id, '8893346208');
  assert.match(t.text, new RegExp(`NEUE STÖRUNG #${r.daten.ticket}`));
  assert.match(t.text, /Standort: Halle Test[\s\S]*Fehler: Alarm[\s\S]*Automat: A-07[\s\S]*Gemeldet: Maria[\s\S]*❌ Nein[\s\S]*seit heute früh[\s\S]*KRITISCH/);
  const knopf = t.reply_markup.inline_keyboard[0];
  assert.deepEqual(knopf.map(k => k.text), ['🔧 Bin dran', '✅ Erledigt']);
  assert.equal(knopf[1].url, `https://papagkrs.github.io/slotwatch/erledigt.html?id=${z[0].id}&k=${z[0].schluessel}&a=done`);
  assert.ok(!JSON.stringify(r.daten).includes(z[0].schluessel), 'der Melder bekommt den Techniker-Schlüssel nicht');
});

test('dieselbe Meldung zweimal gesendet = eine Zeile, eine Nachricht', async () => {
  const m = meldung();
  const a = await ruf('POST', '/api/meldung', m);
  const b = await ruf('POST', '/api/meldung', m);
  assert.equal(b.code, 200);
  assert.equal(b.daten.doppelt, true);
  assert.equal(b.daten.ticket, a.daten.ticket);
  assert.equal((await zeilen()).length, 1);
  assert.equal(telegram.length, 1);
});

test('Telegram-Ausfall: klarer Fehler statt "versendet"; der nächste Versuch stellt zu, ohne Doppel', async () => {
  const m = meldung();
  telegramKaputt = true;
  const a = await ruf('POST', '/api/meldung', m);
  assert.equal(a.code, 502);
  assert.equal(a.daten.ok, false);
  assert.equal(a.daten.fehler, 'telegram');
  assert.equal((await zeilen())[0].telegram_msg_id, null, 'gilt als NICHT zugestellt');
  telegramKaputt = false;
  const b = await ruf('POST', '/api/meldung', m);
  assert.equal(b.code, 200);
  assert.equal(b.daten.ticket, a.daten.ticket);
  const z = await zeilen();
  assert.equal(z.length, 1);
  assert.ok(z[0].telegram_msg_id);
});

test('unvollständige Meldung: abgelehnt, nichts gespeichert, nichts gesendet', async () => {
  for (const kaputt of [{ automat: '' }, { melder: '   ' }, { spielbar: 'ja' }, { standort: undefined }, { anfrage_id: 'kurz' }]) {
    const r = await ruf('POST', '/api/meldung', meldung(kaputt));
    assert.equal(r.code, 400, JSON.stringify(kaputt));
  }
  assert.equal((await zeilen()).length, 0);
  assert.equal(telegram.length, 0);
});

test('Bremse: die 11. Meldung desselben Absenders in 10 Minuten wird abgelehnt, ein anderer Absender nicht', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await ruf('POST', '/api/meldung', meldung({ standort: 'Halle ' + i }))).code, 200);
  const r = await ruf('POST', '/api/meldung', meldung({ standort: 'Halle X' }));
  assert.equal(r.code, 429);
  assert.equal(r.daten.fehler, 'bremse');
  assert.equal((await zeilen()).length, 10);
  assert.equal(gesendet('sendMessage').length, 10);
  ip = '10.0.0.2';
  assert.equal((await ruf('POST', '/api/meldung', meldung({ standort: 'Halle Y' }))).code, 200);
});

test('Bremse je Standort: nach 60 Meldungen in 1 Stunde ist Schluss', async () => {
  const jetzt = new Date().toISOString();
  for (let i = 0; i < 60; i++) {
    await env.DB.prepare("INSERT INTO meldungen (anfrage_id, schluessel, standort, fehlertyp, automat, melder, spielbar, monat, erstellt, absender) VALUES (?, 's', 'Halle Voll', 'Alarm', ?, 'x', 1, '2000-01', ?, ?)")
      .bind('alt-' + i, 'G-' + i, jetzt, 'abs-' + i).run();
  }
  assert.equal((await ruf('POST', '/api/meldung', meldung({ standort: 'Halle Voll' }))).code, 429);
  assert.equal(telegram.length, 0);
});

test('3. Störung desselben Geräts im Monat löst die Warnung aus (Groß/Klein egal), die 2. noch nicht', async () => {
  await ruf('POST', '/api/meldung', meldung({ automat: 'B-01' }));
  await ruf('POST', '/api/meldung', meldung({ automat: 'b-01' }));
  await ruf('POST', '/api/meldung', meldung({ automat: 'B-01', standort: 'Andere Halle' }));
  assert.equal(telegram.filter(t => /ACHTUNG/.test(t.daten.text)).length, 0);
  await ruf('POST', '/api/meldung', meldung({ automat: 'B-01' }));
  const warnung = telegram.filter(t => /ACHTUNG/.test(t.daten.text));
  assert.equal(warnung.length, 1);
  assert.match(warnung[0].daten.text, /Automat B-01 \(Halle Test\) hat schon 3 Störungen/);
});

test('"Bin dran" und "Erledigt": je genau 1 Chat-Nachricht, Wiederholungen senden nichts', async () => {
  await ruf('POST', '/api/meldung', meldung());
  const z = (await zeilen())[0];
  telegram = [];
  const k = { id: z.id, k: z.schluessel };

  const dran = await ruf('POST', '/api/status', { ...k, aktion: 'dran' });
  assert.equal(dran.code, 200);
  assert.equal(dran.daten.status, 'in_arbeit');
  assert.equal(dran.daten.chat, true);
  assert.match(gesendet('sendMessage')[0].daten.text, new RegExp(`^🔧 BIN DRAN — Störung #${5000 + z.id}, Automat A-07`));
  assert.equal(gesendet('sendMessage')[0].daten.reply_to_message_id, z.telegram_msg_id);
  assert.deepEqual(gesendet('editMessageReplyMarkup')[0].daten.reply_markup.inline_keyboard[0].map(x => x.text), ['✅ Erledigt']);

  const nochmal = await ruf('POST', '/api/status', { ...k, aktion: 'dran' });   // z.B. zweiter Techniker, anderes Handy
  assert.equal(nochmal.daten.schon, true);
  assert.equal(gesendet('sendMessage').length, 1);

  const fertig = await ruf('POST', '/api/status', { ...k, aktion: 'done' });
  assert.equal(fertig.daten.status, 'erledigt');
  assert.match(gesendet('sendMessage')[1].daten.text, /^✅ ERLEDIGT — /);
  assert.deepEqual(gesendet('editMessageReplyMarkup')[1].daten.reply_markup.inline_keyboard, []);

  for (const aktion of ['done', 'dran']) {
    const r = await ruf('POST', '/api/status', { ...k, aktion });
    assert.equal(r.daten.schon, true);
    assert.equal(r.daten.status, 'erledigt');
  }
  assert.equal(gesendet('sendMessage').length, 2);
  const ende = (await zeilen())[0];
  assert.equal(ende.status, 'erledigt');
  assert.ok(ende.dran_am && ende.erledigt_am);
});

test('Status ändern ohne gültigen Schlüssel geht nicht', async () => {
  await ruf('POST', '/api/meldung', meldung());
  const z = (await zeilen())[0];
  telegram = [];
  assert.equal((await ruf('POST', '/api/status', { id: z.id, k: 'falsch', aktion: 'done' })).code, 404);
  assert.equal((await ruf('POST', '/api/status', { id: z.id, aktion: 'done' })).code, 400);
  assert.equal((await ruf('POST', '/api/status', { id: z.id, k: z.schluessel, aktion: 'loeschen' })).code, 400);
  assert.equal((await zeilen())[0].status, 'offen');
  assert.equal(telegram.length, 0);
});

test('Status wird gespeichert, auch wenn die Chat-Nachricht scheitert — und das wird ehrlich gemeldet', async () => {
  await ruf('POST', '/api/meldung', meldung());
  const z = (await zeilen())[0];
  telegramKaputt = true;
  const r = await ruf('POST', '/api/status', { id: z.id, k: z.schluessel, aktion: 'done' });
  assert.equal(r.daten.ok, true);
  assert.equal(r.daten.chat, false);
  assert.equal((await zeilen())[0].status, 'erledigt');
});

test('Foto: wird 1x an Telegram weitergereicht; Fehler wird gemeldet; unbekannte Meldung abgelehnt', async () => {
  const m = meldung();
  await ruf('POST', '/api/meldung', m);
  const bild = () => { const f = new FormData(); f.append('photo', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), 'x.jpg'); return f; };
  telegram = [];

  assert.equal((await ruf('POST', '/api/foto?anfrage_id=gibt-es-nicht-123', bild())).code, 404);
  assert.equal((await ruf('POST', '/api/foto?anfrage_id=' + m.anfrage_id, new FormData())).code, 400);
  assert.equal(telegram.length, 0);

  telegramKaputt = true;
  assert.equal((await ruf('POST', '/api/foto?anfrage_id=' + m.anfrage_id, bild())).code, 502);
  telegramKaputt = false;
  const ok = await ruf('POST', '/api/foto?anfrage_id=' + m.anfrage_id, bild());
  assert.equal(ok.code, 200);
  assert.match(gesendet('sendPhoto')[1].daten.caption, /Foto zu Störung #5\d+/);
  const doppelt = await ruf('POST', '/api/foto?anfrage_id=' + m.anfrage_id, bild());
  assert.equal(doppelt.daten.doppelt, true);
  assert.equal(gesendet('sendPhoto').length, 2, 'ein Fehlversuch + ein erfolgreicher Versand, kein dritter');
});

test('Übersicht: nur mit Kennwort; zeigt offen/erledigt und Statistik, aber keine Schlüssel', async () => {
  await ruf('POST', '/api/meldung', meldung({ automat: 'C-01', spielbar: false }));
  await ruf('POST', '/api/meldung', meldung({ automat: 'C-01' }));
  await ruf('POST', '/api/meldung', meldung({ automat: 'C-02', standort: 'Halle Zwei' }));
  const z = await zeilen();
  await ruf('POST', '/api/status', { id: z[2].id, k: z[2].schluessel, aktion: 'done' });

  assert.equal((await ruf('GET', '/api/uebersicht')).code, 401);
  assert.equal((await ruf('GET', '/api/uebersicht', undefined, { 'X-Admin-Key': 'falsch' })).code, 401);
  const r = await ruf('GET', '/api/uebersicht', undefined, { 'X-Admin-Key': 'geheim' });
  assert.equal(r.code, 200);
  assert.equal(r.daten.offen.length, 2);
  assert.equal(r.daten.offen[0].spielbar, 0, 'nicht spielbare Geräte stehen oben');
  assert.equal(r.daten.erledigt.length, 1);
  assert.deepEqual(r.daten.geraete[0], { standort: 'Halle Test', automat: 'C-01', anzahl: 2 });
  assert.deepEqual(r.daten.standorte.map(s => [s.standort, s.anzahl]), [['Halle Test', 2], ['Halle Zwei', 1]]);
  const roh = JSON.stringify(r.daten);
  for (const zeile of z) assert.ok(!roh.includes(zeile.schluessel) && !roh.includes(zeile.absender));

  const ohne = await dienst.fetch(new Request('https://slotwatch.example/api/uebersicht'), { ...env, ADMIN_KEY: undefined });
  assert.equal(ohne.status, 503);
});

test('Browser-Zugriff: nur von der eigenen Webseite erlaubt', async () => {
  const eigen = await ruf('OPTIONS', '/api/meldung');
  assert.equal(eigen.code, 204);
  assert.equal(eigen.kopf.get('Access-Control-Allow-Origin'), 'https://papagkrs.github.io');
  const fremd = await ruf('OPTIONS', '/api/meldung', undefined, { Origin: 'https://boese.example' });
  assert.equal(fremd.kopf.get('Access-Control-Allow-Origin'), null);
  assert.equal((await ruf('GET', '/api/gibt-es-nicht')).code, 404);
});

// ---------- Ausbau 25.11.2026 ----------
const admin = { 'X-Admin-Key': 'geheim' };
const altern = (id, stunden) => env.DB.prepare('UPDATE meldungen SET erstellt = ? WHERE id = ?').bind(new Date(Date.now() - stunden * 3600e3).toISOString(), id).run();

test('Melder sieht den echten Stand seiner Meldung — ohne Namen und ohne Techniker-Schlüssel', async () => {
  const m = meldung();
  await ruf('POST', '/api/meldung', m);
  const z = (await zeilen())[0];
  let r = await ruf('GET', '/api/meldung?anfrage_id=' + m.anfrage_id);
  assert.equal(r.code, 200);
  assert.equal(r.daten.status, 'offen');
  assert.equal(r.daten.zugestellt, true);
  assert.equal(r.daten.ticket, 5000 + z.id);
  await ruf('POST', '/api/status', { id: z.id, k: z.schluessel, aktion: 'dran', wer: 'Kosta' });
  r = await ruf('GET', '/api/meldung?anfrage_id=' + m.anfrage_id);
  assert.equal(r.daten.status, 'in_arbeit');
  assert.ok(r.daten.dran_am);
  await ruf('POST', '/api/status', { id: z.id, k: z.schluessel, aktion: 'done', wer: 'Kosta' });
  r = await ruf('GET', '/api/meldung?anfrage_id=' + m.anfrage_id);
  assert.equal(r.daten.status, 'erledigt');
  const roh = JSON.stringify(r.daten);
  assert.ok(!roh.includes(z.schluessel) && !roh.includes('Kosta') && !roh.includes('Maria'));
  assert.equal((await ruf('GET', '/api/meldung?anfrage_id=gibt-es-nicht-000')).code, 404);
});

test('Technikername steht im Chat und in der Übersicht; ohne Namen geht es weiterhin', async () => {
  await ruf('POST', '/api/meldung', meldung());
  await ruf('POST', '/api/meldung', meldung({ automat: 'X-2' }));
  const z = await zeilen();
  telegram = [];
  await ruf('POST', '/api/status', { id: z[0].id, k: z[0].schluessel, aktion: 'dran', wer: '  Kosta  ' });
  await ruf('POST', '/api/status', { id: z[0].id, k: z[0].schluessel, aktion: 'done', wer: 'Ali' });
  await ruf('POST', '/api/status', { id: z[1].id, k: z[1].schluessel, aktion: 'done' });
  const texte = gesendet('sendMessage').map(t => t.daten.text);
  assert.match(texte[0], /^🔧 BIN DRAN — Kosta — Störung #/);
  assert.match(texte[1], /^✅ ERLEDIGT — Ali — Störung #/);
  assert.match(texte[2], /^✅ ERLEDIGT — Störung #/);
  const u = await ruf('GET', '/api/uebersicht', undefined, admin);
  const e = u.daten.erledigt.find(x => x.automat === 'A-07');
  assert.equal(e.dran_von, 'Kosta');
  assert.equal(e.erledigt_von, 'Ali');
});

test('Reparaturdauer: Durchschnitt für Reaktion und Reparatur im Monat', async () => {
  await ruf('POST', '/api/meldung', meldung({ automat: 'D-1' }));
  await ruf('POST', '/api/meldung', meldung({ automat: 'D-2' }));
  await ruf('POST', '/api/meldung', meldung({ automat: 'D-3' }));   // bleibt offen, zählt nicht in die Dauer
  const z = await zeilen();
  const t0 = new Date('2026-11-10T10:00:00.000Z');
  const plus = min => new Date(t0.getTime() + min * 60000).toISOString();
  const monat = (await zeilen())[0].monat;
  await env.DB.prepare("UPDATE meldungen SET erstellt = ?, dran_am = ?, erledigt_am = ?, status = 'erledigt', monat = ? WHERE id = ?").bind(plus(0), plus(10), plus(60), monat, z[0].id).run();
  await env.DB.prepare("UPDATE meldungen SET erstellt = ?, dran_am = ?, erledigt_am = ?, status = 'erledigt', monat = ? WHERE id = ?").bind(plus(0), plus(30), plus(120), monat, z[1].id).run();
  const u = await ruf('GET', '/api/uebersicht', undefined, admin);
  assert.deepEqual(u.daten.dauer, { erledigt: 2, reaktion_min: 20, reparatur_min: 90 });
  assert.equal(u.daten.standorte[0].reparatur_min, 90);
});

test('Erinnerung: nicht spielbar nach 2 Std., spielbar nach 24 Std., je Störung nur 1x, nie wenn jemand dran ist', async () => {
  const neu = async (mehr) => { await ruf('POST', '/api/meldung', meldung(mehr)); const z = await zeilen(); return z[z.length - 1]; };
  const kritischAlt = await neu({ automat: 'K-ALT', spielbar: false });  await altern(kritischAlt.id, 3);
  const kritischNeu = await neu({ automat: 'K-NEU', spielbar: false });  await altern(kritischNeu.id, 1);
  const normalAlt = await neu({ automat: 'N-ALT' });                     await altern(normalAlt.id, 25);
  const normalNeu = await neu({ automat: 'N-NEU' });                     await altern(normalNeu.id, 5);
  const inArbeit = await neu({ automat: 'K-DRAN', spielbar: false });    await altern(inArbeit.id, 9);
  await ruf('POST', '/api/status', { id: inArbeit.id, k: inArbeit.schluessel, aktion: 'dran' });
  await env.DB.prepare("INSERT INTO meldungen (anfrage_id, schluessel, standort, fehlertyp, automat, melder, spielbar, monat, erstellt) VALUES ('nie-zugestellt-1', 's', 'H', 'Alarm', 'K-NIE', 'x', 0, '2026-11', ?)")
    .bind(new Date(Date.now() - 9 * 3600e3).toISOString()).run();
  telegram = [];

  const lauf1 = await dienst.zeitlauf(env);
  assert.equal(lauf1.erinnert, 2);
  const texte = gesendet('sendMessage').map(t => t.daten.text).sort();
  assert.match(texte[0], /ERINNERUNG: Störung #\d+ \(Automat K-ALT, Halle Test\) ist seit 3 Std\. offen/);
  assert.match(texte[1], /Automat N-ALT, Halle Test\) ist seit 25 Std\. offen/);
  assert.equal(gesendet('sendMessage').find(t => /K-ALT/.test(t.daten.text)).daten.reply_to_message_id, kritischAlt.telegram_msg_id);

  telegram = [];
  assert.equal((await dienst.zeitlauf(env)).erinnert, 0, 'zweiter Lauf erinnert nicht nochmal');
  assert.equal(telegram.length, 0);

  // Telegram-Ausfall: Erinnerung gilt als NICHT gesendet und kommt beim nächsten Lauf
  await altern(kritischNeu.id, 4);
  telegramKaputt = true;
  assert.equal((await dienst.zeitlauf(env)).erinnert, 0);
  telegramKaputt = false;
  assert.equal((await dienst.zeitlauf(env)).erinnert, 1);

  // abschaltbar
  await altern(normalNeu.id, 30);
  assert.equal((await dienst.zeitlauf({ ...env, ERINNERUNG_NORMAL_STD: '0' })).erinnert, 0);
});

test('Aufbewahrung: nach 12 Monaten verschwinden Namen und Freitext, die Statistik bleibt; 0 = nie', async () => {
  await ruf('POST', '/api/meldung', meldung({ automat: 'ALT-1', beschreibung: 'privat' }));
  await ruf('POST', '/api/meldung', meldung({ automat: 'NEU-1', beschreibung: 'bleibt' }));
  const z = await zeilen();
  await ruf('POST', '/api/status', { id: z[0].id, k: z[0].schluessel, aktion: 'done', wer: 'Kosta' });
  await altern(z[0].id, 24 * 400);
  await altern(z[1].id, 24 * 300);
  assert.equal((await dienst.zeitlauf({ ...env, AUFBEWAHRUNG_MONATE: '0' })).anonymisiert, 0);
  assert.equal((await dienst.zeitlauf(env)).anonymisiert, 1);
  const [alt, neu] = await zeilen();
  assert.deepEqual([alt.melder, alt.beschreibung, alt.erledigt_von], ['', '', '']);
  assert.ok(alt.anonymisiert_am);
  assert.deepEqual([alt.automat, alt.standort, alt.status], ['ALT-1', 'Halle Test', 'erledigt'], 'Gerät, Standort und Status bleiben für die Statistik');
  assert.deepEqual([neu.melder, neu.beschreibung, neu.anonymisiert_am], ['Maria', 'bleibt', null]);
  assert.equal((await dienst.zeitlauf(env)).anonymisiert, 0, 'nicht doppelt');
});

test('Standorte: nur mit Kennwort verwaltbar; unbekannter Standort wird angenommen, aber markiert', async () => {
  assert.equal((await ruf('GET', '/api/standorte')).code, 401);
  assert.equal((await ruf('POST', '/api/standorte', { name: 'Halle Test' })).code, 401);
  assert.equal((await ruf('POST', '/api/standorte', { name: '  ' }, admin)).code, 400);
  let r = await ruf('POST', '/api/standorte', { name: 'Halle Test' }, admin);
  r = await ruf('POST', '/api/standorte', { name: 'Halle Zwei' }, admin);
  r = await ruf('POST', '/api/standorte', { name: 'Halle Test' }, admin);   // doppelt = kein zweiter Eintrag
  assert.deepEqual(r.daten.standorte, [{ name: 'Halle Test', aktiv: 1 }, { name: 'Halle Zwei', aktiv: 1 }]);
  r = await ruf('POST', '/api/standorte', { name: 'Halle Zwei', aktiv: false }, admin);
  assert.deepEqual(r.daten.standorte, [{ name: 'Halle Test', aktiv: 1 }, { name: 'Halle Zwei', aktiv: 0 }]);

  assert.equal((await ruf('POST', '/api/meldung', meldung({ standort: 'Halle Test' }))).code, 200);
  assert.equal((await ruf('POST', '/api/meldung', meldung({ standort: 'Halle Zwei' }))).code, 200);
  assert.equal((await ruf('POST', '/api/meldung', meldung({ standort: 'Erfunden' }))).code, 200);
  assert.deepEqual((await zeilen()).map(z => [z.standort, z.standort_bekannt]), [['Halle Test', 1], ['Halle Zwei', 0], ['Erfunden', 0]]);
  const u = await ruf('GET', '/api/uebersicht', undefined, admin);
  assert.equal(u.daten.offen.filter(m => !m.standort_bekannt).length, 2);
});

test('Sicherung: Export nur mit Kennwort; enthält alle Störungen, aber keine Schlüssel', async () => {
  await ruf('POST', '/api/meldung', meldung());
  await ruf('POST', '/api/meldung', meldung({ automat: 'E-2' }));
  await ruf('POST', '/api/standorte', { name: 'Halle Test' }, admin);
  assert.equal((await ruf('GET', '/api/export')).code, 401);
  const r = await ruf('GET', '/api/export', undefined, admin);
  assert.equal(r.code, 200);
  assert.equal(r.daten.meldungen.length, 2);
  assert.equal(r.daten.standorte.length, 1);
  const roh = JSON.stringify(r.daten);
  for (const z of await zeilen()) assert.ok(!roh.includes(z.schluessel) && !roh.includes(z.absender) && !roh.includes(z.anfrage_id));
});

test('Kennwort durchprobieren wird gebremst: nach 10 Fehlversuchen ist 10 Minuten Schluss — auch mit richtigem Kennwort', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await ruf('GET', '/api/uebersicht', undefined, { 'X-Admin-Key': 'falsch' + i })).code, 401);
  assert.equal((await ruf('GET', '/api/uebersicht', undefined, { 'X-Admin-Key': 'falsch' })).code, 429);
  assert.equal((await ruf('GET', '/api/uebersicht', undefined, admin)).code, 429);
  ip = '10.0.0.9';
  assert.equal((await ruf('GET', '/api/uebersicht', undefined, admin)).code, 200, 'ein anderer Absender ist nicht betroffen');
});

test('Betreiber-Trennung: eigener Chat, eigenes Kennwort, keiner sieht die Daten des anderen', async () => {
  // Anlegen nur mit dem Haupt-Kennwort
  const neu = { slug: 'mueller', name: 'Spielhallen Müller', telegram_chat_id: '-1001234567' };
  assert.equal((await ruf('POST', '/api/betreiber', neu)).code, 401);
  assert.equal((await ruf('POST', '/api/betreiber', { ...neu, slug: 'eigen' }, admin)).code, 400);
  assert.equal((await ruf('POST', '/api/betreiber', { ...neu, telegram_chat_id: 'abc' }, admin)).code, 400);
  const angelegt = await ruf('POST', '/api/betreiber', neu, admin);
  assert.equal(angelegt.code, 200);
  const kennwortMueller = angelegt.daten.kennwort;
  assert.ok(kennwortMueller.length >= 20);
  assert.equal((await ruf('POST', '/api/betreiber', neu, admin)).code, 409);
  const liste = await ruf('GET', '/api/betreiber', undefined, admin);
  assert.deepEqual(liste.daten.betreiber.map(b => [b.slug, b.aktiv]), [['mueller', 1]]);
  assert.ok(!JSON.stringify(liste.daten).includes(kennwortMueller), 'das Kennwort wird nie wieder ausgegeben');
  const gespeichert = (await env.DB.prepare('SELECT admin_pruefsumme FROM betreiber').first('admin_pruefsumme'));
  assert.ok(gespeichert !== kennwortMueller && gespeichert.length === 64, 'gespeichert ist nur die Prüfsumme');

  // Meldungen landen im jeweils eigenen Chat
  telegram = [];
  await ruf('POST', '/api/meldung', meldung({ automat: 'EIGEN-1' }));
  await ruf('POST', '/api/meldung', meldung({ automat: 'MUE-1', betreiber: 'mueller' }));
  assert.deepEqual(gesendet('sendMessage').map(t => t.daten.chat_id), ['8893346208', '-1001234567']);
  assert.equal((await ruf('POST', '/api/meldung', meldung({ betreiber: 'gibt-es-nicht' }))).code, 404);
  assert.equal(telegram.length, 2);

  // "Erledigt" geht in den Chat des richtigen Betreibers
  const zm = (await zeilen()).find(z => z.automat === 'MUE-1');
  telegram = [];
  await ruf('POST', '/api/status', { id: zm.id, k: zm.schluessel, aktion: 'done' });
  assert.deepEqual([...new Set(telegram.map(t => t.daten.chat_id))], ['-1001234567']);

  // Übersicht, Export und Standorte sind getrennt
  const mue = { 'X-Admin-Key': kennwortMueller };
  const uEigen = await ruf('GET', '/api/uebersicht', undefined, admin);
  const uMue = await ruf('GET', '/api/uebersicht?b=mueller', undefined, mue);
  assert.deepEqual(uEigen.daten.offen.map(m => m.automat), ['EIGEN-1']);
  assert.deepEqual(uMue.daten.erledigt.map(m => m.automat), ['MUE-1']);
  assert.equal(uMue.daten.offen.length, 0);
  assert.equal((await ruf('GET', '/api/uebersicht', undefined, mue)).code, 401, 'Müller-Kennwort öffnet die eigenen Hallen nicht');
  assert.equal((await ruf('GET', '/api/uebersicht?b=mueller', undefined, admin)).code, 401, 'Haupt-Kennwort öffnet Müller nicht');
  assert.equal((await ruf('GET', '/api/betreiber', undefined, mue)).code, 401, 'Müller kann keine Betreiber verwalten');
  assert.equal((await ruf('GET', '/api/export?b=mueller', undefined, mue)).daten.meldungen.length, 1);
  await ruf('POST', '/api/standorte?b=mueller', { name: 'Müller Halle 1' }, mue);
  assert.equal((await ruf('GET', '/api/standorte', undefined, admin)).daten.standorte.length, 0);
  assert.equal((await ruf('GET', '/api/standorte?b=mueller', undefined, mue)).daten.standorte.length, 1);

  // Die 3.-Störung-Warnung zählt je Betreiber getrennt
  telegram = [];
  await ruf('POST', '/api/meldung', meldung({ automat: 'GLEICH' }));
  await ruf('POST', '/api/meldung', meldung({ automat: 'GLEICH' }));
  await ruf('POST', '/api/meldung', meldung({ automat: 'GLEICH', betreiber: 'mueller' }));
  assert.equal(telegram.filter(t => /ACHTUNG/.test(t.daten.text)).length, 0);

  // Abschalten: QR-Codes und Kennwort des Betreibers gelten nicht mehr
  await ruf('POST', '/api/betreiber', { ...neu, aktiv: false }, admin);
  assert.equal((await ruf('POST', '/api/meldung', meldung({ betreiber: 'mueller' }))).code, 404);
  assert.equal((await ruf('GET', '/api/uebersicht?b=mueller', undefined, mue)).code, 401);
});
