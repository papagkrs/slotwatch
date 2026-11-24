// Prüft den Hauptablauf "Störung melden" zweimal hintereinander — ohne echtes Telegram.
// Alle Netz-Aufrufe werden abgefangen; es geht KEINE Nachricht raus.
// Start: node tests/zweite_meldung.test.js   (braucht Playwright + Chromium)
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const SEITE = 'file://' + path.join(__dirname, '..', 'index.html') + '?standort=Halle%20Test';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  // Dieser Test prüft den ALTEN Weg (direkt an Telegram) — er bleibt als Rückfallweg erhalten.
  await page.addInitScript(() => Object.defineProperty(window, 'SLOTWATCH_API', { value: '', writable: false }));
  const gesendet = [];   // abgefangene sendMessage-Texte
  const fehler = [];     // JavaScript-Fehler auf der Seite
  page.on('pageerror', e => fehler.push(e.message));
  page.on('dialog', d => { fehler.push('Dialog: ' + d.message()); d.dismiss(); });

  await page.route(/^https?:\/\//, route => {
    const url = route.request().url();
    if (!url.includes('api.telegram.org')) return route.abort(); // z.B. Schriftarten
    if (url.endsWith('/sendMessage')) gesendet.push(JSON.parse(route.request().postData()).text);
    return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ ok: true, result: { message_id: 100 + gesendet.length } }) });
  });

  async function melden(fehlerKnopf, automat, name, spielbarKnopf, mitFoto) {
    await page.click(`.error-btn:has-text("${fehlerKnopf}")`);
    await page.click('#step1Content .step-btn-next');
    await page.fill('#automat', automat);
    if (name !== null) await page.fill('#melder', name);
    await page.click(spielbarKnopf);
    await page.click('#step2Content .step-btn-next');
    if (mitFoto) {
      await page.setInputFiles('#foto', { name: 'foto.png', mimeType: 'image/png', buffer: PNG });
      await page.waitForSelector('#photoPreview.visible');
    }
    await page.click('#submitBtn');
    await page.waitForSelector('#successBox', { state: 'visible' });
  }

  try {
    await page.goto(SEITE);

    // 1. Meldung (mit Foto)
    await melden('Alarm', 'A-07', 'Maria', '#btnJa', true);
    assert.strictEqual(gesendet.length, 1, 'erste Meldung muss genau 1x gesendet werden');

    // "+ Neue Störung melden" muss ein frisches Formular auf Schritt 1 zeigen
    await page.click('.btn-new');
    assert.deepStrictEqual(fehler, [], 'kein JavaScript-Fehler beim Foto und beim Zurücksetzen');
    assert.ok(await page.isVisible('#step1Content'), 'Formular steht wieder auf Schritt 1');
    assert.ok(!(await page.isVisible('#step3Content')), 'Schritt 3 ist nicht mehr sichtbar');
    assert.strictEqual(await page.locator('.error-btn.selected').count(), 0, 'kein Problem vorausgewählt');
    assert.strictEqual(await page.locator('#photoBtn.has-photo').count(), 0, 'altes Foto ist weg');
    assert.strictEqual(await page.inputValue('#automat'), '', 'Geräte-Nummer ist leer');
    assert.strictEqual(await page.inputValue('#melder'), 'Maria', 'Name bleibt gemerkt');

    // 2. Meldung (ohne Foto, Name nicht neu getippt) muss vollständig durchgehen
    await melden('2€ Münzen', 'B-02', null, '#btnNein', false);
    assert.strictEqual(gesendet.length, 2, 'zweite Meldung muss genau 1x gesendet werden');
    assert.match(gesendet[1], /#4002/);
    assert.match(gesendet[1], /Automat: B-02/);
    assert.match(gesendet[1], /Fehler: 2€ LEER/);
    assert.match(gesendet[1], /Gemeldet: Maria/);
    assert.match(gesendet[1], /KRITISCH/);
    assert.deepStrictEqual(fehler, [], 'kein JavaScript-Fehler im ganzen Ablauf');

    console.log('OK — zwei Meldungen hintereinander funktionieren (2 abgefangene Nachrichten, 0 Fehler)');
  } catch (e) {
    console.error('FEHLGESCHLAGEN:', e.message);
    if (fehler.length) console.error('Seitenfehler:', fehler);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
