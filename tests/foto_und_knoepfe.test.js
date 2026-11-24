// Prüft (ohne echtes Telegram — alle Netz-Aufrufe werden abgefangen):
//   1. Scheitert der Foto-Versand, sagt die Erfolgsseite das ehrlich.
//   2. Zweimal "Bin dran" schreibt nur EINMAL in den Chat.
// Start: node tests/foto_und_knoepfe.test.js   (braucht Playwright + Chromium)
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const ORDNER = 'file://' + path.join(__dirname, '..') + '/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function neueSeite(browser, fotoOk) {
  const page = await browser.newPage();
  const aufrufe = [];
  await page.route(/^https?:\/\//, route => {
    const url = route.request().url();
    if (!url.includes('api.telegram.org')) return route.abort();
    const methode = url.split('/').pop();
    aufrufe.push(methode);
    if (methode === 'sendPhoto' && !fotoOk)
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: false, description: 'Bad Request' }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, result: { message_id: 7 } }) });
  });
  return { page, aufrufe };
}

async function meldungMitFoto(browser, fotoOk) {
  const { page } = await neueSeite(browser, fotoOk);
  await page.goto(ORDNER + 'index.html?standort=Halle%20Test');
  await page.click('.error-btn:has-text("Alarm")');
  await page.click('#step1Content .step-btn-next');
  await page.fill('#automat', 'A-07');
  await page.fill('#melder', 'Maria');
  await page.click('#btnJa');
  await page.click('#step2Content .step-btn-next');
  await page.setInputFiles('#foto', { name: 'foto.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForSelector('#photoPreview.visible');
  await page.click('#submitBtn');
  await page.waitForSelector('#successBox', { state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('fotoStatus').textContent.includes('wird gesendet'));
  const text = await page.innerText('#successDetail');
  await page.close();
  return text;
}

(async () => {
  const browser = await chromium.launch();
  try {
    const gut = await meldungMitFoto(browser, true);
    assert.match(gut, /📷 Mit Foto/, 'Foto angekommen -> "Mit Foto"');

    const schlecht = await meldungMitFoto(browser, false);
    assert.match(schlecht, /Foto konnte nicht gesendet werden/, 'Foto gescheitert -> ehrlicher Hinweis');
    assert.doesNotMatch(schlecht, /Mit Foto/, 'kein "Mit Foto", wenn das Foto nicht ankam');
    assert.match(schlecht, /Versendet/, 'die Meldung selbst gilt weiter als versendet');

    const { page, aufrufe } = await neueSeite(browser, true);
    const link = ORDNER + 'erledigt.html?a=dran&chat=1&msg=7&ticket=4001&geraet=A-07&standort=Halle%20Test';
    const titel = async () => { await page.waitForFunction(() => document.getElementById('titel').textContent !== 'Wird gespeichert…'); return page.innerText('#titel'); };
    await page.goto(link);
    assert.match(await titel(), /Bin dran/);
    await page.goto(link);
    assert.strictEqual(await titel(), 'Schon gespeichert', 'zweiter Druck wird erkannt');
    assert.strictEqual(aufrufe.filter(m => m === 'sendMessage').length, 1, '"Bin dran" steht nur 1x im Chat');
    await page.goto(link.replace('a=dran', 'a=done'));
    assert.match(await titel(), /Erledigt gespeichert/, '"Erledigt" geht danach weiterhin');
    assert.strictEqual(aufrufe.filter(m => m === 'sendMessage').length, 2);

    console.log('OK — Foto-Fehler wird angezeigt, doppeltes "Bin dran" sendet nur einmal');
  } catch (e) {
    console.error('FEHLGESCHLAGEN:', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
