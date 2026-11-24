// Gesamttest: echte Seiten im Browser  ->  echter SlotWatch-Dienst (Cloudflare-Laufzeit lokal)
//             ->  echte lokale Datenbank (D1).   ERSETZT ist nur Telegram (Attrappe auf diesem Rechner).
// Es geht KEINE echte Nachricht raus. Die Handys sind nachgestellt (Bildschirmgröße, Touch) — keine echten Geräte.
// Start: (cd worker && npm install) && node tests/gesamt_mit_dienst.test.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, execFileSync } = require('child_process');
const { chromium, devices } = require('playwright');

const WURZEL = path.join(__dirname, '..');
const WORKER = path.join(WURZEL, 'worker');
const P_SEITE = 8811, P_DIENST = 8799, P_TELEGRAM = 8798;
const SEITE = `http://127.0.0.1:${P_SEITE}`, DIENST = `http://127.0.0.1:${P_DIENST}`;

const telegram = [];        // was die Attrappe empfangen hat
let telegramKaputt = false;

// Großes Testfoto (3000 x 2000 Bildpunkte, ca. 18 MB) — so groß wie ein unkomprimiertes Handyfoto.
function grossesFoto() {
  const b = 3000, h = 2000, daten = b * h * 3;
  const bmp = Buffer.alloc(54 + daten);
  bmp.write('BM'); bmp.writeUInt32LE(54 + daten, 2); bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(b, 18); bmp.writeInt32LE(h, 22);
  bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(daten, 34);
  for (let i = 54; i < bmp.length; i++) bmp[i] = (i * 7) & 0xff;
  return bmp;
}
// Breite/Höhe aus einem JPEG lesen (Start-of-Frame-Marke)
function jpegMasse(roh) {
  const start = roh.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  for (let i = start; i >= 0 && i < roh.length - 9; i++) {
    if (roh[i] === 0xff && (roh[i + 1] === 0xc0 || roh[i + 1] === 0xc2)) return { hoehe: roh.readUInt16BE(i + 5), breite: roh.readUInt16BE(i + 7) };
  }
  return null;
}

function starteTelegramAttrappe() {
  return http.createServer((req, res) => {
    const teile = [];
    req.on('data', t => teile.push(t));
    req.on('end', () => {
      const methode = req.url.split('/').pop();
      const roh = Buffer.concat(teile);
      let daten;
      if ((req.headers['content-type'] || '').includes('json')) daten = JSON.parse(roh.toString());
      else daten = { formular: true, bytes: roh.length, masse: jpegMasse(roh), chat_id: (roh.toString('latin1').match(/name="chat_id"\r\n\r\n([^\r]+)/) || [])[1] };
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
    // Im Test: Dienst = lokale Adresse, Stand-Abfrage alle 0,4 s statt alle 20 s
    if (pfad === '/config.js') { res.setHeader('Content-Type', typ['.js']); res.end(`window.SLOTWATCH_API = '${DIENST}'; window.SLOTWATCH_STAND_MS = 400;`); return; }
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
  if (foto) { await page.setInputFiles('#foto', { name: 'f.bmp', mimeType: 'image/bmp', buffer: foto }); await page.waitForSelector('#photoPreview.visible'); }
  await page.click('#submitBtn');
}
const nachrichten = muster => telegram.filter(t => t.methode === 'sendMessage' && muster.test(t.daten.text));
const wartend = ['Wird gespeichert…'];
const titelVon = async page => { await page.waitForFunction(w => !w.includes(document.getElementById('titel').textContent), wartend); return page.innerText('#titel'); };
// Knopf in Telegram drücken; beim ersten Mal auf diesem Handy wird nach dem Namen gefragt
async function druecke(page, url, name) {
  await page.goto(url);
  if (await titelVon(page) === 'Wer bist du?') {
    assert.ok(name, 'Name wurde unerwartet abgefragt');
    await page.fill('#technikerName', name);
    await page.click('#nameWeiter');
    await page.waitForFunction(() => document.getElementById('titel').textContent !== 'Wer bist du?');
  }
  return titelVon(page);
}
const standText = (page, muster) => page.waitForFunction(m => new RegExp(m).test(document.getElementById('successStatus').textContent), muster, { timeout: 10000 });

(async () => {
  const datenOrdner = fs.mkdtempSync(path.join(os.tmpdir(), 'slotwatch-test-'));
  const attrappe = starteTelegramAttrappe(), seiten = starteSeiten();
  let dienst, browser;
  try {
    dienst = await starteDienst(datenOrdner);
    browser = await chromium.launch();
    const handyMelder = await browser.newContext({ ...devices['Pixel 7'] });
    const handyTechniker = await browser.newContext({ ...devices['iPhone 13'] });
    const handyZweiter = await browser.newContext({ ...devices['Galaxy S9+'] });
    const seitenFehler = [];
    const beobachte = (p, wo) => { p.on('pageerror', e => seitenFehler.push(wo + ': ' + e.message)); p.on('dialog', d => { seitenFehler.push(wo + ' Dialog: ' + d.message()); d.dismiss(); }); return p; };
    const page = beobachte(await handyMelder.newPage(), 'Melden');
    await handyMelder.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());

    // 1. Meldung mit großem Foto (Handy-Ansicht): kommt an, Foto wird vorher verkleinert
    await page.goto(SEITE + '/?standort=Halle%20Test');
    assert.ok(!(await page.isVisible('#ticketSection')), 'die alte Nur-dieses-Handy-Liste ist ausgeblendet');
    await fuelleFormular(page, { fehler: 'Alarm', automat: 'a-07', name: 'Maria', spielbar: false, foto: grossesFoto(),
      text: '=HYPERLINK("x")<img src=x onerror="window.__xss=1">' });
    await page.waitForSelector('#successBox', { state: 'visible' });
    await page.waitForFunction(() => /Mit Foto/.test(document.getElementById('successDetail').textContent), null, { timeout: 60000 });
    assert.match(await page.innerText('#successDetail'), /Ticket #5001/);
    assert.strictEqual(nachrichten(/NEUE STÖRUNG #5001/).length, 1);
    const fotoAufruf = telegram.find(t => t.methode === 'sendPhoto');
    assert.ok(fotoAufruf.daten.masse, 'bei Telegram kam ein JPEG an');
    assert.deepStrictEqual(fotoAufruf.daten.masse, { hoehe: 1067, breite: 1600 }, 'Foto wurde von 3000x2000 auf 1600 Breite verkleinert');
    assert.ok(fotoAufruf.daten.bytes < 3 * 1024 * 1024, 'verkleinertes Foto ist unter 3 MB (Original: 18 MB)');
    const knopf = nachrichten(/NEUE STÖRUNG #5001/)[0].daten.reply_markup.inline_keyboard[0];

    // 2. Die Erfolgsseite des Melders zeigt den ECHTEN Stand
    await standText(page, 'benachrichtigt – noch keine Rückmeldung');
    const tech = beobachte(await handyTechniker.newPage(), 'Techniker'), zweiter = beobachte(await handyZweiter.newPage(), 'Zweiter');
    assert.match(await druecke(tech, knopf[0].url, 'Kosta'), /Bin dran/);
    await standText(page, 'Techniker ist dran seit \\d\\d:\\d\\d');
    assert.match(nachrichten(/BIN DRAN/)[0].daten.text, /^🔧 BIN DRAN — Kosta — Störung #5001/, 'der Technikername steht im Chat');

    // 3. Zweiter Techniker, anderes Handy: nichts Doppeltes im Chat
    assert.strictEqual(await druecke(zweiter, knopf[0].url, 'Ali'), 'Schon gespeichert');
    assert.strictEqual(nachrichten(/BIN DRAN — /).length, 1);
    assert.match(await druecke(zweiter, knopf[1].url), /Erledigt gespeichert/, 'der Name wird beim zweiten Mal nicht mehr gefragt');
    assert.match(nachrichten(/ERLEDIGT/)[0].daten.text, /^✅ ERLEDIGT — Ali — Störung #5001/);
    assert.strictEqual(await druecke(tech, knopf[1].url), 'Schon erledigt');
    assert.strictEqual(nachrichten(/ERLEDIGT — /).length, 1);
    await standText(page, '✅ Erledigt um \\d\\d:\\d\\d');

    // 4. Telegram fällt aus: "NICHT angekommen" statt "Versendet"; zweiter Druck stellt zu, ohne Doppel
    await page.click('.btn-new');
    assert.strictEqual(await page.inputValue('#melder'), 'Maria');
    telegramKaputt = true;
    await fuelleFormular(page, { fehler: '2€ Münzen', automat: 'B-02', spielbar: true });
    await page.waitForSelector('#errorMsg', { state: 'visible' });
    assert.match(await page.innerText('#errorMsg'), /NICHT angekommen/);
    assert.ok(!(await page.isVisible('#successBox')), 'keine Erfolgsmeldung bei Ausfall');
    telegramKaputt = false;
    await page.click('#submitBtn');
    await page.waitForSelector('#successBox', { state: 'visible' });
    assert.match(await page.innerText('#successDetail'), /Ticket #5002/);
    assert.strictEqual(nachrichten(/NEUE STÖRUNG #5002/).length, 2, '1 Fehlversuch + 1 Zustellung bei der Attrappe');

    // 5. Knopf-Link mit falschem Schlüssel: klarer Fehler, nichts im Chat
    const vorher = telegram.length;
    assert.strictEqual(await druecke(tech, knopf[1].url.replace(/id=1&k=[0-9a-f]+/, 'id=2&k=falsch')), 'Nicht gespeichert');
    assert.strictEqual(telegram.length, vorher);

    // 6. Standort-Verwaltung: Anmeldung, anlegen, alte Nur-dieses-Gerät-Einträge übernehmen, ausschalten
    const buero = await browser.newContext();
    await buero.route(/fonts\.(googleapis|gstatic)\.com|api\.qrserver\.com/, r => r.abort());
    await buero.addInitScript(() => { if (!localStorage.getItem('vorbereitet')) { localStorage.setItem('vorbereitet', '1'); localStorage.setItem('slotwatch_standorte', JSON.stringify(['Halle Test', 'Alt Lokal'])); } });
    const admin = beobachte(await buero.newPage(), 'Admin');
    await admin.goto(SEITE + '/admin.html');
    await admin.fill('#kennwort', 'falsch'); await admin.click('#anmelden');
    await admin.waitForFunction(() => document.getElementById('anmeldeFehler').textContent !== '');
    assert.strictEqual(await admin.innerText('#anmeldeFehler'), 'Falsches Kennwort.');
    await admin.fill('#kennwort', 'geheim'); await admin.click('#anmelden');
    await admin.waitForSelector('#inhalt', { state: 'visible' });
    assert.strictEqual(await admin.innerText('#totalCount'), '0');
    assert.match(await admin.innerText('#lokalListe'), /Halle Test[\s\S]*Alt Lokal/, 'alte Einträge dieses Browsers werden angeboten');
    await admin.fill('#newStandort', 'Halle Test'); await admin.click('#hinzufuegen');
    await admin.waitForFunction(() => document.getElementById('totalCount').textContent === '1');
    await admin.click('#uebernehmen');
    await admin.waitForFunction(() => document.getElementById('totalCount').textContent === '2');
    assert.ok(!(await admin.isVisible('#lokalKarte')), 'nichts mehr zu übernehmen');
    await admin.click('.standort-item:has-text("Alt Lokal") .delete-btn');
    await admin.waitForFunction(() => document.getElementById('totalCount').textContent === '1');
    assert.match(await admin.innerText('#standorteList'), /Alt Lokal \(aus\)/);

    // 7. QR-Seite: zeigt die zentrale Liste (nur aktive), QR-Adresse enthält den Standort
    const qr = beobachte(await buero.newPage(), 'QR');
    await qr.goto(SEITE + '/qr.html');
    await qr.waitForFunction(() => /Zentrale Standort-Liste \(1\)/.test(document.getElementById('quelle').textContent));
    assert.strictEqual(await qr.locator('.qr-card').count(), 1);
    assert.match(await qr.innerText('.qr-card'), /Halle Test/);
    assert.ok(decodeURIComponent(await qr.getAttribute('.qr-card img', 'src')).endsWith('?standort=' + encodeURIComponent('Halle Test')));

    // 8. Übersicht: Zahlen, Dauer, Technikernamen, Markierung für unbekannten Standort, Eingaben werden nicht ausgeführt
    const chef = beobachte(await buero.newPage(), 'Übersicht');
    await chef.goto(SEITE + '/uebersicht.html');
    await chef.waitForSelector('#inhalt', { state: 'visible' });   // Kennwort ist in diesem Browser schon gemerkt
    assert.strictEqual(await chef.innerText('#zOffen'), '1');
    assert.strictEqual(await chef.innerText('#zKritisch'), '0');
    assert.strictEqual(await chef.innerText('#zMonat'), '2');
    assert.strictEqual(await chef.innerText('#zErledigt'), '1');
    assert.match(await chef.innerText('#zReparatur'), /^\d+ Min$/);
    assert.match(await chef.innerText('#offen'), /B-02[\s\S]*Halle Test[\s\S]*#5002/);
    assert.match(await chef.innerText('#offen'), /steht nicht in der Standort-Liste/, 'Meldung von vor dem Anlegen des Standorts ist markiert');
    const erledigt = await chef.innerText('#erledigt');
    assert.match(erledigt, /A-07[\s\S]*#5001[\s\S]*von Ali[\s\S]*Dauer \d+ Min[\s\S]*<img src=x/, 'Eingabe steht als Text da');
    assert.strictEqual(await chef.evaluate(() => window.__xss), undefined, 'eingeschleuster Code wurde NICHT ausgeführt');
    assert.strictEqual(await chef.locator('#erledigt img').count(), 0);

    // 9. Sicherung als Tabelle: enthält die Störungen; Formel-Anfänge sind entschärft
    const [datei] = await Promise.all([chef.waitForEvent('download'), chef.click('#sicherungCsv')]);
    const csv = fs.readFileSync(await datei.path(), 'utf8');
    assert.match(datei.suggestedFilename(), /^slotwatch-sicherung-\d{4}-\d\d-\d\d\.csv$/);
    assert.match(csv, /^\ufeffticket;standort;automat;/);
    assert.match(csv, /"5001";"Halle Test";"A-07";"Alarm";"0";"erledigt";"Maria";"'=HYPERLINK/);
    assert.strictEqual(csv.trim().split('\r\n').length, 3, 'Kopfzeile + 2 Störungen');

    // 10. Weiterer Betreiber: eigener QR-Code, eigener Chat, eigene Übersicht — die eigenen Hallen sehen nichts davon
    const neu = await (await fetch(DIENST + '/api/betreiber', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'geheim' },
      body: JSON.stringify({ slug: 'mueller', name: 'Spielhallen Müller', telegram_chat_id: '-100555' }) })).json();
    assert.strictEqual(neu.ok, true);
    const fremd = beobachte(await (await browser.newContext({ ...devices['Pixel 7'] })).newPage(), 'Fremdbetreiber');
    await fremd.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await fremd.goto(SEITE + '/?standort=M%C3%BCller%20Halle&b=mueller');
    await fuelleFormular(fremd, { fehler: 'Schein', automat: 'M-1', name: 'Petra', spielbar: true });
    await fremd.waitForSelector('#successBox', { state: 'visible' });
    assert.strictEqual(nachrichten(/Müller Halle/)[0].daten.chat_id, '-100555', 'Meldung ging in den Chat des anderen Betreibers');
    const chefMueller = beobachte(await (await browser.newContext()).newPage(), 'Übersicht Müller');
    await chefMueller.goto(SEITE + '/uebersicht.html?b=mueller');
    await chefMueller.fill('#kennwort', 'geheim'); await chefMueller.click('#anmelden');
    await chefMueller.waitForFunction(() => document.getElementById('anmeldeFehler').textContent !== '');
    assert.strictEqual(await chefMueller.innerText('#anmeldeFehler'), 'Falsches Kennwort.', 'das Haupt-Kennwort öffnet den anderen Betreiber nicht');
    await chefMueller.fill('#kennwort', neu.kennwort); await chefMueller.click('#anmelden');
    await chefMueller.waitForSelector('#inhalt', { state: 'visible' });
    assert.match(await chefMueller.innerText('#betreiberName'), /Spielhallen Müller/);
    assert.match(await chefMueller.innerText('#offen'), /M-1/);
    assert.ok(!/B-02/.test(await chefMueller.innerText('main')), 'Müller sieht die eigenen Hallen nicht');
    await chef.click('#neuLaden');
    await chef.waitForFunction(() => /Stand/.test(document.getElementById('betreiberName').textContent));
    assert.ok(!/M-1/.test(await chef.innerText('main')), 'die eigenen Hallen sehen Müller nicht');
    assert.strictEqual(await chef.innerText('#zOffen'), '1');

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
