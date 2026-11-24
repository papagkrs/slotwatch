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
beforeEach(async () => { telegram = []; telegramKaputt = false; ip = '10.0.0.1'; await env.DB.prepare('DELETE FROM meldungen').run(); });

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
