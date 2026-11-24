-- SlotWatch: zentrales Gedächtnis (Cloudflare D1) — vollständiges Schema für eine NEUE Datenbank.
-- Anwenden: npx wrangler d1 execute slotwatch --remote --file=schema.sql
-- Eine bestehende Datenbank vom Stand 24.11.2026 wird mit upgrade_2.sql nachgezogen.
CREATE TABLE IF NOT EXISTS meldungen (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  betreiber        TEXT    NOT NULL DEFAULT 'eigen',   -- welcher Betreiber (eigene Hallen = 'eigen')
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
  absender         TEXT    NOT NULL DEFAULT '',        -- Prüfsumme der Absender-Adresse (nur für die Bremse)
  dran_von         TEXT    NOT NULL DEFAULT '',        -- wer "Bin dran" gedrückt hat
  erledigt_von     TEXT    NOT NULL DEFAULT '',        -- wer "Erledigt" gedrückt hat
  erinnert_am      TEXT,                               -- wann an die offene Störung erinnert wurde
  standort_bekannt INTEGER NOT NULL DEFAULT 1,         -- 0 = Standort steht nicht in der Standort-Liste
  anonymisiert_am  TEXT                                -- wann Namen/Freitext entfernt wurden
);
CREATE INDEX IF NOT EXISTS idx_meldungen_status   ON meldungen (betreiber, status, erstellt);
CREATE INDEX IF NOT EXISTS idx_meldungen_geraet   ON meldungen (betreiber, monat, standort, automat);
CREATE INDEX IF NOT EXISTS idx_meldungen_absender ON meldungen (absender, erstellt);

CREATE TABLE IF NOT EXISTS standorte (
  betreiber TEXT    NOT NULL DEFAULT 'eigen',
  name      TEXT    NOT NULL,
  aktiv     INTEGER NOT NULL DEFAULT 1,
  erstellt  TEXT    NOT NULL,
  PRIMARY KEY (betreiber, name)
);

CREATE TABLE IF NOT EXISTS betreiber (                 -- weitere Betreiber; 'eigen' steht NICHT hier, sondern in den Einstellungen
  slug             TEXT PRIMARY KEY,                   -- Kurzname in der Adresse, z.B. ?b=mueller
  name             TEXT    NOT NULL,
  telegram_chat_id TEXT    NOT NULL,
  admin_pruefsumme TEXT    NOT NULL,                   -- Prüfsumme des Kennworts, nie das Kennwort selbst
  aktiv            INTEGER NOT NULL DEFAULT 1,
  erstellt         TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS fehlversuche (              -- falsche Kennwort-Eingaben (Bremse gegen Durchprobieren)
  absender TEXT NOT NULL,
  zeit     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fehlversuche ON fehlversuche (absender, zeit);
