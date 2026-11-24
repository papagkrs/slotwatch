// Gesamttest: echte Seiten im Browser  ->  echter SlotWatch-Dienst (Cloudflare-Laufzeit lokal)
//             ->  echte lokale Datenbank (D1).   ERSETZT ist nur Telegram (Attrappe auf diesem Rechner).
// Es geht KEINE echte Nachricht raus.
// Start: (cd worker && npm install) && node tests/gesamt_mit_dienst.test.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, execFileSync } = require('child_process');
const { chromium } = require('playwright');

const WURZEL = path.join(__dirname, '..');
const WORKER = path.join(WURZEL, 'worker');
const P_SEITE = 8811, P_DIENST = 8799, P_TELEGRAM = 8798;
const SEITE = `http://127.0.0.1:${P_SEITE}`, DIENST = `http://127.0.0.1:${P_DIENST}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const telegram = [];        // was die Attrappe empfangen hat
let telegramKaputt = false;

function starteTelegramAttrappe() {
  return http.createServer((req, res) => {
    const teile = [];
    req.on('data', t => teile.push(t));
    req.on('end', () => {
      const methode = req.url.split('/').pop();
      const roh = Buffer.concat(teile);
      let daten = {};
      if ((req.headers['content-type'] || '').includes('json')) daten = JSON.parse(roh.toString());
      else daten = { formular: true, bytes: roh.length, text: roh.toString('latin1').slice(0, 2000) };
      telegram.push({ methode, daten });
      res.setHeader('Content-Type', 'application/json');
      if (telegramKaputt) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, description: 'Attrappe: Ausfall' })); return; }
      res.end(JSON.stringify({ ok: true, result: { message_id: 700 + telegram.length } }));
    });
  }).listen(P_TELEGRAM, '127.0.0.1');
}

function starteSeiten() {
  const typ = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  return http.createServer((req, res) => {
    const pfad = decodeURIComponent(req.url.split('?')[0]);
    if (pfad === '/config.js') { res.setHeader('Content-Type', typ['.js']); res.end(`window.SLOTWATCH_API = '${DIENST}';`); return; }
    const datei = path.join(WURZEL, pfad === '/' ? 'index.html' : pfad.replace(/^\/+/, ''));
    if (!datei.startsWith(WURZEL) || !fs.existsSync(datei)) { res.statusCode = 404; res.end('nicht gefunden'); return; }
    res.setHeader('Content-Type', typ[path.extname(datei)] || 'application/octet-stream');
    res.end(fs.readFileSync(datei));
  }).listen(P_SEITE, '127.0.0.1');
}

async function starteDienst(datenOrdner) {
  const wrangler = path.join(WORKER, 'node_modules', '.bin', 'wrangler');
  execFileSync(wrangler, ['d1', 'execute', 'slotwatch', '--local', '--persist-to', datenOrdner, '--file=schema.sql'], { cwd: WORKER, stdio: 'pipe' });
  const prozess = spawn(wrangler, ['dev', '--local', '--port', String(P_DIENST), '--persist-to', datenOrdner,
    '--var', 'TELEGRAM_TOKEN:TEST', '--var', `TELEGRAM_API:http://127.0.0.1:${P_TELEGRAM}`, '--var', 'ADMIN_KEY:geheim',
    '--var', `SEITE:${SEITE}`, '--var', `ERLAUBTE_HERKUNFT:${SEITE}`], { cwd: WORKER, stdio: 'pipe', detached: true });
  for (let i = 0; i < 60; i++) {
    const da = await new Promise(ok => http.get(DIENST + '/', r => { r.resume(); ok(true); }).on('error', () => ok(false)));
    if (da) return prozess;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Dienst startet nicht');
}

async function fuelleFormular(page, { fehler, automat, name, spielbar, text, foto }) {
  await page.click(`.error-btn:has-text("${fehler}")`);
  await page.click('#step1Content .step-btn-next');
  await page.fill('#automat', automat);
  if (name) await page.fill('#melder', name);
  await page.click(spielbar ? '#btnJa' : '#btnNein');
  if (text) await page.fill('#beschreibung', text);
  await page.click('#step2Content .step-btn-next');
  if (foto) { await page.setInputFiles('#foto', { name: 'f.png', mimeType: 'image/png', buffer: PNG }); await page.waitForSelector('#photoPreview.visible'); }
  await page.click('#submitBtn');
}
const nachrichten = muster => telegram.filter(t => t.methode === 'sendMessage' && muster.test(t.daten.text));
const titelVon = async page => { await page.waitForFunction(() => document.getElementById('titel').textContent !== 'Wird gespeichert…'); return page.innerText('#titel'); };

(async () => {
  const datenOrdner = fs.mkdtempSync(path.join(os.tmpdir(), 'slotwatch-test-'));
  const attrappe = starteTelegramAttrappe(), seiten = starteSeiten();
  let dienst, browser;
  try {
    dienst = await starteDienst(datenOrdner);
    browser = await chromium.launch();
    const handyMelder = await browser.newContext(), handyTechniker = await browser.newContext(), handyZweiter = await browser.newContext();
    const seitenFehler = [];
    const page = await handyMelder.newPage();
    page.on('pageerror', e => seitenFehler.push(e.message));
    page.on('dialog', d => { seitenFehler.push('Dialog: ' + d.message()); d.dismiss(); });
    await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());

    // 1. Meldung mit Foto: kommt an, zentrale Ticket-Nummer, Knöpfe hängen direkt dran
    await page.goto(SEITE + '/?standort=Halle%20Test');
    await fuelleFormular(page, { fehler: 'Alarm', automat: 'a-07', name: 'Maria', spielbar: false, foto: true,
      text: '<img src=x onerror="window.__xss=1">' });
    await page.waitForSelector('#successBox', { state: 'visible' });
    await page.waitForFunction(() => /Mit Foto/.test(document.getElementById('successDetail').textContent));
    assert.match(await page.innerText('#successDetail'), /Ticket #5001/);
    assert.strictEqual(nachrichten(/NEUE STÖRUNG #5001/).length, 1);
    assert.strictEqual(telegram.filter(t => t.methode === 'sendPhoto').length, 1, 'Foto wurde weitergereicht');
    const knopf = nachrichten(/NEUE STÖRUNG #5001/)[0].daten.reply_markup.inline_keyboard[0];
    assert.ok(knopf[0].url.startsWith(SEITE + '/erledigt.html?id=1&k='), 'Knopf-Link zeigt auf die Erledigt-Seite');

    // 2. Telegram fällt aus: die Seite sagt "NICHT angekommen" (kein falsches "Versendet") ...
    await page.click('.btn-new');
    telegramKaputt = true;
    await fuelleFormular(page, { fehler: '2€ Münzen', automat: 'B-02', spielbar: true });
    await page.waitForSelector('#errorMsg', { state: 'visible' });
    assert.match(await page.innerText('#errorMsg'), /NICHT angekommen/);
    assert.ok(!(await page.isVisible('#successBox')), 'keine Erfolgsmeldung bei Ausfall');
    // ... und der zweite Druck stellt zu, ohne doppelte Störung
    telegramKaputt = false;
    await page.click('#submitBtn');
    await page.waitForSelector('#successBox', { state: 'visible' });
    assert.match(await page.innerText('#successDetail'), /Ticket #5002/);
    assert.strictEqual(nachrichten(/NEUE STÖRUNG #5002/).length, 2, '1 Fehlversuch + 1 Zustellung bei der Attrappe');

    // 3. "Bin dran" auf Handy A, nochmal auf Handy B: steht nur 1x im Chat
    const tech = await handyTechniker.newPage(), zweiter = await handyZweiter.newPage();
    await tech.goto(knopf[0].url);
    assert.match(await titelVon(tech), /Bin dran/);
    await zweiter.goto(knopf[0].url);
    assert.strictEqual(await titelVon(zweiter), 'Schon gespeichert');
    assert.strictEqual(nachrichten(/BIN DRAN — Störung #5001/).length, 1);

    // 4. "Erledigt" auf Handy B, nochmal auf Handy A: steht nur 1x im Chat
    await zweiter.goto(knopf[1].url);
    assert.match(await titelVon(zweiter), /Erledigt gespeichert/);
    await tech.goto(knopf[1].url);
    assert.strictEqual(await titelVon(tech), 'Schon erledigt');
    assert.strictEqual(nachrichten(/ERLEDIGT — Störung #5001/).length, 1);

    // 5. Knopf-Link mit falschem Schlüssel: klarer Fehler, nichts im Chat
    const vorher = telegram.length;
    await tech.goto(knopf[1].url.replace(/id=1&k=[0-9a-f]+/, 'id=2&k=falsch'));
    assert.strictEqual(await titelVon(tech), 'Nicht gespeichert');
    assert.strictEqual(telegram.length, vorher);

    // 6. Übersicht: falsches Kennwort abgelehnt; richtiges zeigt 1 offen + 1 erledigt; Eingaben werden nicht ausgeführt
    const chef = await (await browser.newContext()).newPage();
    chef.on('pageerror', e => seitenFehler.push('Übersicht: ' + e.message));
    await chef.goto(SEITE + '/uebersicht.html');
    await chef.fill('#kennwort', 'falsch'); await chef.click('#anmelden');
    await chef.waitForFunction(() => document.getElementById('anmeldeFehler').textContent !== '');
    assert.strictEqual(await chef.innerText('#anmeldeFehler'), 'Falsches Kennwort.');
    assert.ok(!(await chef.isVisible('#inhalt')));
    await chef.fill('#kennwort', 'geheim'); await chef.click('#anmelden');
    await chef.waitForSelector('#inhalt', { state: 'visible' });
    assert.strictEqual(await chef.innerText('#zOffen'), '1');
    assert.strictEqual(await chef.innerText('#zKritisch'), '0');
    assert.strictEqual(await chef.innerText('#zMonat'), '2');
    assert.match(await chef.innerText('#offen'), /B-02[\s\S]*Halle Test[\s\S]*#5002/);
    assert.match(await chef.innerText('#erledigt'), /A-07[\s\S]*#5001[\s\S]*<img src=x/, 'Eingabe steht als Text da');
    assert.strictEqual(await chef.evaluate(() => window.__xss), undefined, 'eingeschleuster Code wurde NICHT ausgeführt');
    assert.strictEqual(await chef.locator('#erledigt img').count(), 0);

    assert.deepStrictEqual(seitenFehler, [], 'keine JavaScript-Fehler oder Dialoge auf den Seiten');
    console.log(`OK — Gesamtablauf mit Dienst und Datenbank funktioniert (${telegram.length} Aufrufe bei der Telegram-Attrappe, 0 echte)`);
  } catch (e) {
    console.error('FEHLGESCHLAGEN:', e.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (dienst) { try { process.kill(-dienst.pid, 'SIGKILL'); } catch (e) {} }
    attrappe.close(); seiten.close();
    fs.rmSync(datenOrdner, { recursive: true, force: true });
  }
})();
