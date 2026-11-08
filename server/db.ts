import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
// Money is kept in minor units (kuruş for TRY) as integers, so sums never round.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- A company. Its plan (an id from the file) is what Helpdesk routes by; users is how many seats they have.
   CREATE TABLE companies (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     domain TEXT,
     sector TEXT,
     city TEXT,
     plan TEXT,
     plan_renews TEXT,
     users INTEGER,
     owner_id TEXT,
     owner_name TEXT,
     external_id TEXT UNIQUE,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX companies_name ON companies (name COLLATE NOCASE);
   -- A person. Email is unique: Helpdesk and Audience find people by it and nothing else.
   CREATE TABLE contacts (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT UNIQUE,
     phone TEXT,
     title TEXT,
     company_id TEXT REFERENCES companies (id) ON DELETE SET NULL,
     owner_id TEXT,
     owner_name TEXT,
     source TEXT NOT NULL,
     external_id TEXT UNIQUE,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX contacts_company ON contacts (company_id);
   CREATE INDEX contacts_phone ON contacts (phone);
   -- A deal in a pipeline's stage, or won or lost. last_activity_at is what stale is measured from.
   CREATE TABLE deals (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     pipeline TEXT NOT NULL,
     stage TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('open', 'won', 'lost')),
     value_minor INTEGER NOT NULL DEFAULT 0,
     currency TEXT NOT NULL,
     company_id TEXT REFERENCES companies (id) ON DELETE SET NULL,
     contact_id TEXT REFERENCES contacts (id) ON DELETE SET NULL,
     owner_id TEXT,
     owner_name TEXT,
     expected_close TEXT,
     source TEXT NOT NULL,
     source_detail TEXT,
     reason TEXT,
     reason_note TEXT,
     closed_at TEXT,
     stage_entered_at TEXT NOT NULL,
     last_activity_at TEXT NOT NULL,
     external_id TEXT UNIQUE,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX deals_open ON deals (status, pipeline, stage);
   CREATE INDEX deals_owner ON deals (owner_id, status);
   CREATE INDEX deals_company ON deals (company_id);
   CREATE INDEX deals_contact ON deals (contact_id);
   CREATE INDEX deals_closed ON deals (closed_at) WHERE closed_at IS NOT NULL;
   -- Every stage a deal was in, and when it entered and left it, for time in stage. won and lost are stages here too.
   CREATE TABLE stage_history (
     id INTEGER PRIMARY KEY,
     deal_id TEXT NOT NULL REFERENCES deals (id) ON DELETE CASCADE,
     pipeline TEXT NOT NULL,
     stage TEXT NOT NULL,
     entered_at TEXT NOT NULL,
     left_at TEXT,
     by_name TEXT
   );
   CREATE INDEX stage_history_deal ON stage_history (deal_id, entered_at);
   CREATE INDEX stage_history_left ON stage_history (left_at) WHERE left_at IS NOT NULL;
   -- Calls, meetings, emails and notes people log, and what CRM itself notes (stage changes, quotes, bookings, leads).
   CREATE TABLE activities (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('call', 'meeting', 'email', 'note', 'system')),
     text TEXT NOT NULL,
     deal_id TEXT REFERENCES deals (id) ON DELETE CASCADE,
     contact_id TEXT REFERENCES contacts (id) ON DELETE CASCADE,
     company_id TEXT REFERENCES companies (id) ON DELETE CASCADE,
     at TEXT NOT NULL,
     by_id TEXT,
     by_name TEXT NOT NULL,
     event TEXT,
     data TEXT,
     created_at TEXT NOT NULL
   );
   CREATE INDEX activities_deal ON activities (deal_id, at);
   CREATE INDEX activities_contact ON activities (contact_id, at);
   CREATE INDEX activities_company ON activities (company_id, at);
   -- A task with its due day (and time, when it has one) and its reminder.
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     text TEXT NOT NULL,
     deal_id TEXT REFERENCES deals (id) ON DELETE CASCADE,
     contact_id TEXT REFERENCES contacts (id) ON DELETE CASCADE,
     owner_id TEXT,
     owner_name TEXT,
     due_date TEXT NOT NULL,
     due_time TEXT,
     remind_at TEXT,
     reminded_at TEXT,
     done_at TEXT,
     done_by TEXT,
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL
   );
   CREATE INDEX tasks_owner ON tasks (owner_id, done_at, due_date);
   CREATE INDEX tasks_remind ON tasks (remind_at) WHERE reminded_at IS NULL AND done_at IS NULL;
   CREATE INDEX tasks_deal ON tasks (deal_id);
   -- A quote of a deal. The lines and KDV rate are fixed when it is sent; seller is the file's as it was then.
   CREATE TABLE quotes (
     id TEXT PRIMARY KEY,
     number TEXT NOT NULL UNIQUE,
     deal_id TEXT NOT NULL REFERENCES deals (id) ON DELETE CASCADE,
     state TEXT NOT NULL CHECK (state IN ('draft', 'sent', 'accepted', 'declined')),
     currency TEXT NOT NULL,
     vat REAL NOT NULL,
     valid_until TEXT NOT NULL,
     notes TEXT,
     seller TEXT NOT NULL,
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL,
     sent_at TEXT,
     decided_at TEXT
   );
   CREATE INDEX quotes_deal ON quotes (deal_id);
   CREATE TABLE quote_lines (
     quote_id TEXT NOT NULL REFERENCES quotes (id) ON DELETE CASCADE,
     pos INTEGER NOT NULL,
     item TEXT NOT NULL,
     quantity REAL NOT NULL,
     unit_minor INTEGER NOT NULL,
     discount REAL NOT NULL DEFAULT 0,
     PRIMARY KEY (quote_id, pos)
   ) WITHOUT ROWID;
   -- The year's last quote number: Q-2026-118.
   CREATE TABLE quote_numbers (year INTEGER PRIMARY KEY, last INTEGER NOT NULL);
   -- A member's connected calendar. Tokens are encrypted with the product's key (ADR 0021).
   CREATE TABLE calendar_accounts (
     user_id TEXT PRIMARY KEY,
     provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
     account TEXT NOT NULL,
     refresh_token TEXT NOT NULL,
     access_token TEXT,
     expires_at TEXT,
     connected_at TEXT NOT NULL,
     ok_at TEXT,
     error TEXT
   );
   -- An OAuth sign-in to a calendar that has started and not come back yet.
   CREATE TABLE oauth_states (state TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, created_at TEXT NOT NULL);
   -- A time someone booked through a meeting link. held while the calendar event is being made; a held or confirmed
   -- booking blocks its owner's time, which is what stops two people booking the same time.
   CREATE TABLE bookings (
     id TEXT PRIMARY KEY,
     link TEXT NOT NULL,
     owner_email TEXT NOT NULL,
     start_at TEXT NOT NULL,
     end_at TEXT NOT NULL,
     block_from TEXT NOT NULL,
     block_to TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('held', 'confirmed', 'cancelled', 'failed')),
     name TEXT NOT NULL,
     email TEXT NOT NULL,
     company TEXT,
     note TEXT,
     contact_id TEXT,
     deal_id TEXT,
     made TEXT,
     event_id TEXT,
     join_url TEXT,
     error TEXT,
     created_at TEXT NOT NULL
   );
   CREATE INDEX bookings_owner ON bookings (owner_email, block_from) WHERE state IN ('held', 'confirmed');
   CREATE INDEX bookings_start ON bookings (start_at);
   -- Events for Audience and Messages, sent in the background and tried again until they are taken.
   CREATE TABLE outbox (
     id INTEGER PRIMARY KEY,
     target TEXT NOT NULL CHECK (target IN ('audience', 'messages')),
     event TEXT NOT NULL,
     email TEXT,
     phone TEXT,
     created_at TEXT NOT NULL,
     next_at TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     error TEXT
   );
   CREATE INDEX outbox_due ON outbox (target, next_at);
   -- Deletions Audience asked for, by their reference: kept so asking again gives the same answer.
   CREATE TABLE erasures (reference TEXT PRIMARY KEY, at TEXT NOT NULL, deleted INTEGER NOT NULL);`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
