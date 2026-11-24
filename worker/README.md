# SlotWatch-Dienst (Cloudflare)

Der Dienst ist das zentrale Gedächtnis von SlotWatch. Die Webseiten bleiben auf GitHub;
sie schicken Meldungen an diesen Dienst. Er speichert sie, vergibt die Ticket-Nummer und
benachrichtigt den Techniker per Telegram. Läuft im kostenlosen Cloudflare-Plan.

**Stand:** in Betrieb seit 24.11.2026 unter `https://slotwatch.toworkflow.workers.dev` (Datenbank in der EU).
Steht in `config.js` keine Adresse, arbeiten die Seiten wie früher (direkt an Telegram) — das ist der Rückfallweg.

## Was der Dienst kann

| Adresse | Zweck |
|---|---|
| `POST /api/meldung` | neue Störung speichern + Techniker benachrichtigen |
| `POST /api/foto` | Foto zu einer Störung an Telegram weiterreichen (wird nicht gespeichert) |
| `POST /api/status` | „Bin dran“ / „Erledigt“ (Knöpfe in Telegram) |
| `GET /api/uebersicht` | offene Störungen + Statistik, nur mit Kennwort (Seite `uebersicht.html`) |

- Kommt die Telegram-Nachricht nicht an, meldet das Formular einen Fehler. Nochmal absenden erzeugt keine doppelte Störung.
- „Bin dran“ / „Erledigt“ stehen nur einmal im Chat, auch bei mehreren Handys.
- Bremse: höchstens 10 Meldungen je Absender in 10 Minuten, 60 je Standort pro Stunde.
- Warnung ab der 3. Störung desselben Geräts im selben Monat, zentral gezählt.
- Ticket-Nummern sind eindeutig und beginnen bei 5001.

## Einrichten (einmalig)

1. Kostenloses Cloudflare-Konto anlegen.
2. `cd worker && npm install`
3. Datenbank in der EU anlegen: `npx wrangler d1 create slotwatch --jurisdiction=eu`
   und die ausgegebene `database_id` in `wrangler.toml` eintragen.
4. Tabellen anlegen: `npx wrangler d1 execute slotwatch --remote --file=schema.sql`
5. Geheimnisse setzen (nie in eine Datei schreiben):
   `npx wrangler secret put TELEGRAM_TOKEN` und `npx wrangler secret put ADMIN_KEY` (Kennwort für die Übersicht).
6. Veröffentlichen: `npx wrangler deploy` — die ausgegebene Adresse in `../config.js` eintragen.
7. Mit einer echten Test-Störung prüfen: Meldung, Foto, beide Knöpfe, Übersicht.

Zurück zum alten Weg: `config.js` wieder auf `''` setzen.

## Tests

- `cd worker && npm test` — Dienst gegen eine lokale D1-Datenbank; Telegram ist ersetzt.
- `node tests/gesamt_mit_dienst.test.js` (im Projektordner) — Seiten im Browser, Dienst in der
  lokalen Cloudflare-Laufzeit, lokale Datenbank; Telegram ist eine Attrappe.

Nicht getestet: der Betrieb bei Cloudflare selbst und echtes Telegram.

## Offen

- Der Telegram-Schlüssel steht noch in `index.html`/`erledigt.html` (alter Weg) und im öffentlichen Verlauf.
  Wenn der Dienst läuft: neuen Schlüssel beim BotFather holen, nur noch als Geheimnis setzen, alten Weg entfernen.
- Die Tabelle hat eine Spalte `betreiber` (heute immer `eigen`) als Vorbereitung für mehrere Betreiber.
  Konten und Trennung je Betreiber sind noch nicht gebaut.
