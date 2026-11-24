-- SlotWatch: zentrales Gedächtnis (Cloudflare D1).
-- Anwenden: npx wrangler d1 execute slotwatch --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS meldungen (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  betreiber        TEXT    NOT NULL DEFAULT 'eigen',   -- vorbereitet für mehrere Betreiber
  anfrage_id       TEXT    NOT NULL UNIQUE,            -- gleiche Meldung nochmal gesendet = kein Doppel
  schluessel       TEXT    NOT NULL,                   -- steckt in den Telegram-Knöpfen
  standort         TEXT    NOT NULL,
  fehlertyp        TEXT    NOT NULL,
  automat          TEXT    NOT NULL,
  melder           TEXT    NOT NULL,
  spielbar         INTEGER NOT NULL,                   -- 1 = ja, 0 = nein
  beschreibung     TEXT    NOT NULL DEFAULT '',
  status           TEXT    NOT NULL DEFAULT 'offen',   -- offen | in_arbeit | erledigt
  monat            TEXT    NOT NULL,                   -- z.B. 2026-11 (deutsche Zeit)
  erstellt         TEXT    NOT NULL,                   -- Zeitpunkte in UTC (ISO)
  dran_am          TEXT,
  erledigt_am      TEXT,
  telegram_msg_id  INTEGER,                            -- leer = Techniker wurde noch NICHT benachrichtigt
  foto_gesendet    INTEGER NOT NULL DEFAULT 0,
  absender         TEXT    NOT NULL DEFAULT ''         -- Prüfsumme der Absender-Adresse (nur für die Bremse)
);
CREATE INDEX IF NOT EXISTS idx_meldungen_status   ON meldungen (betreiber, status, erstellt);
CREATE INDEX IF NOT EXISTS idx_meldungen_geraet   ON meldungen (betreiber, monat, standort, automat);
CREATE INDEX IF NOT EXISTS idx_meldungen_absender ON meldungen (absender, erstellt);
