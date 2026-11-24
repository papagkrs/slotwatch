-- Einmalig für die Datenbank vom Stand 24.11.2026 (danach entspricht sie schema.sql).
-- npx wrangler d1 execute slotwatch --remote --file=upgrade_2.sql
ALTER TABLE meldungen ADD COLUMN dran_von         TEXT    NOT NULL DEFAULT '';
ALTER TABLE meldungen ADD COLUMN erledigt_von     TEXT    NOT NULL DEFAULT '';
ALTER TABLE meldungen ADD COLUMN erinnert_am      TEXT;
ALTER TABLE meldungen ADD COLUMN standort_bekannt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE meldungen ADD COLUMN anonymisiert_am  TEXT;
CREATE TABLE IF NOT EXISTS standorte (
  betreiber TEXT    NOT NULL DEFAULT 'eigen',
  name      TEXT    NOT NULL,
  aktiv     INTEGER NOT NULL DEFAULT 1,
  erstellt  TEXT    NOT NULL,
  PRIMARY KEY (betreiber, name)
);
CREATE TABLE IF NOT EXISTS betreiber (
  slug             TEXT PRIMARY KEY,
  name             TEXT    NOT NULL,
  telegram_chat_id TEXT    NOT NULL,
  admin_pruefsumme TEXT    NOT NULL,
  aktiv            INTEGER NOT NULL DEFAULT 1,
  erstellt         TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS fehlversuche (
  absender TEXT NOT NULL,
  zeit     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fehlversuche ON fehlversuche (absender, zeit);
