# SlotWatch-Dienst (Cloudflare)

Der Dienst ist das zentrale Gedächtnis von SlotWatch. Die Webseiten bleiben auf GitHub;
sie schicken Meldungen an diesen Dienst. Er speichert sie, vergibt die Ticket-Nummer und
benachrichtigt den Techniker per Telegram. Läuft im kostenlosen Cloudflare-Plan.

**Stand:** in Betrieb seit 24.11.2026 unter `https://slotwatch.toworkflow.workers.dev` (Datenbank in der EU).
Steht in `config.js` keine Adresse, arbeiten die Seiten wie früher (direkt an Telegram) — das ist der Rückfallweg.

## Was der Dienst kann

| Adresse | Zweck | Zugang |
|---|---|---|
| `POST /api/meldung` | neue Störung speichern + Techniker benachrichtigen | alle |
| `GET /api/meldung?anfrage_id=` | Stand der eigenen Meldung (Erfolgsseite) | wer die Meldung abgeschickt hat |
| `POST /api/foto` | Foto an Telegram weiterreichen (wird nicht gespeichert) | wer die Meldung abgeschickt hat |
| `POST /api/status` | „Bin dran“ / „Erledigt“ | Knopf-Link aus Telegram |
| `GET /api/uebersicht` | offene Störungen, Statistik, Dauer | Kennwort |
| `GET /api/export` | alle Störungen als Sicherung | Kennwort |
| `GET`/`POST /api/standorte` | Standort-Liste lesen / ändern | Kennwort |
| `GET`/`POST /api/betreiber` | weitere Betreiber auflisten / anlegen | Haupt-Kennwort |

- Kommt die Telegram-Nachricht nicht an, meldet das Formular einen Fehler. Nochmal absenden erzeugt keine doppelte Störung.
- „Bin dran“ / „Erledigt“ stehen nur einmal im Chat, auch bei mehreren Handys; der Technikername steht dabei.
- Bremse: höchstens 10 Meldungen je Absender in 10 Minuten, 60 je Standort pro Stunde; 10 falsche Kennwörter in 10 Minuten.
- Warnung ab der 3. Störung desselben Geräts im selben Monat, zentral gezählt.
- Alle 30 Minuten: Erinnerung, wenn niemand „Bin dran“ gedrückt hat (2 Std. bei nicht spielbar, 24 Std. sonst, je Störung einmal);
  nach 12 Monaten werden Namen und Freitext entfernt. Beides einstellbar in `wrangler.toml`.
- Ticket-Nummern sind eindeutig und beginnen bei 5001.

## Weiteren Betreiber anlegen

Nur mit dem Haupt-Kennwort. Die Antwort enthält das Kennwort des neuen Betreibers genau einmal:

    curl -X POST https://slotwatch.toworkflow.workers.dev/api/betreiber \
      -H "Content-Type: application/json" -H "X-Admin-Key: HAUPT-KENNWORT" \
      -d '{"slug":"kurzname","name":"Firma","telegram_chat_id":"-100123"}'

Der Betreiber nutzt dann `qr.html?b=kurzname`, `admin.html?b=kurzname` und `uebersicht.html?b=kurzname`.
Der SlotWatch-Bot muss in dessen Telegram-Chat sein. Abschalten: derselbe Aufruf mit `"aktiv": false`.

## Einrichten (einmalig)

1. Kostenloses Cloudflare-Konto anlegen.
2. `cd worker && npm install`
3. Datenbank in der EU anlegen: `npx wrangler d1 create slotwatch --jurisdiction=eu`
   und die ausgegebene `database_id` in `wrangler.toml` eintragen.
4. Tabellen anlegen: `npx wrangler d1 execute slotwatch --remote --file=schema.sql`
   (bestehende Datenbank vom 24.11.2026 nachziehen: `upgrade_2.sql`; Startliste der eigenen Standorte: `standorte_eigen.sql`)
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

Siehe `../PLAN.md`.
