-- Schema für den Müllerkinder-Planer (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  color      TEXT    NOT NULL DEFAULT '#1971c2',  -- Anzeigefarbe der Person
  token      TEXT    NOT NULL UNIQUE,             -- steckt im Einladungslink, gilt unbegrenzt
  is_admin   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Eine Tageshälfte einer Person. half: 0 = Vormittag, 1 = Nachmittag, 2 = Abend.
-- level: -1 = schlecht (Blocker), 2 = mittel, 3 = gut. 1 wird nicht mehr vergeben.
-- Eine Zeile ohne Level, aber mit Notiz, ist nicht erlaubt: Notizen hängen an einem Eintrag.
CREATE TABLE IF NOT EXISTS slots (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT    NOT NULL,                    -- 'YYYY-MM-DD'
  half       INTEGER NOT NULL CHECK (half IN (0, 1, 2)),
  level      INTEGER NOT NULL CHECK (level IN (-1, 1, 2, 3)),
  note       TEXT,                                -- z. B. „nur bis 21 Uhr“
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (user_id, day, half)
);

-- Blocker über ganze Tage, z. B. Urlaub. Beide Grenzen inklusive.
CREATE TABLE IF NOT EXISTS blocks (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_day  TEXT    NOT NULL,
  to_day    TEXT    NOT NULL,
  label     TEXT
);

-- Wiederkehrende Regeln, z. B. „Mo–Fr vormittags Arbeit“ (Blocker)
-- oder „abends nur bis 21 Uhr“ (Hinweis).
-- weekdays: 7 Zeichen '0'/'1' für Mo..So, halves: 3 Zeichen für Vormittag..Abend.
CREATE TABLE IF NOT EXISTS rules (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekdays  TEXT    NOT NULL,
  halves    TEXT    NOT NULL,
  kind      TEXT    NOT NULL CHECK (kind IN ('block', 'note')),
  text      TEXT
);

CREATE INDEX IF NOT EXISTS idx_slots_day ON slots(day);
