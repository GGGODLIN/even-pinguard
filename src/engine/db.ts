import { DatabaseSync } from "node:sqlite";
import type { DeliveryStatus, LockState } from "./types.js";

export interface FactRow {
  fact_key: string;
  text: string;
  questions: string;
  revision: number;
  effective_at: number;
  version: number;
  lock_state: LockState;
  confirmed: number;
  conflict_id: string | null;
  conflict_text: string | null;
  conflict_chat_id: string | null;
  conflict_message_id: number | null;
  conflict_timestamp: number | null;
}

export interface ClusterRow {
  cluster_id: string;
  fact_key: string;
  status: "COLLECTING" | "READY" | "EXECUTING" | "COMPLETE";
  groups_json: string;
}

export interface DeliveryRow {
  action_id: string;
  chat_id: string;
  message_id: number | null;
  status: DeliveryStatus;
  error: string | null;
}

export function openPinGuardDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: 5_000 });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        fact_key TEXT PRIMARY KEY,
        questions TEXT NOT NULL,
        active_revision INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        lock_state TEXT NOT NULL DEFAULT 'CLEAR' CHECK (lock_state IN ('CLEAR', 'HOLD_CONFLICT', 'AWAITING_CONFIRM')),
        confirmed INTEGER NOT NULL DEFAULT 0,
        conflict_id TEXT UNIQUE,
        conflict_text TEXT,
        conflict_chat_id TEXT,
        conflict_message_id INTEGER,
        conflict_timestamp INTEGER,
        conflict_card_sent INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS fact_revisions (
        fact_key TEXT NOT NULL REFERENCES facts(fact_key),
        revision INTEGER NOT NULL,
        text TEXT NOT NULL,
        effective_at INTEGER NOT NULL,
        PRIMARY KEY (fact_key, revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS clusters (
        cluster_id TEXT PRIMARY KEY,
        fact_key TEXT NOT NULL REFERENCES facts(fact_key),
        status TEXT NOT NULL CHECK (status IN ('COLLECTING', 'READY', 'EXECUTING', 'COMPLETE')),
        groups_json TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_cluster_per_fact
        ON clusters(fact_key) WHERE status != 'COMPLETE';
      CREATE TABLE IF NOT EXISTS deliveries (
        action_id TEXT NOT NULL REFERENCES clusters(cluster_id),
        chat_id TEXT NOT NULL,
        message_id INTEGER,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'SEND_IN_FLIGHT', 'PINNED', 'PIN_FAILED', 'SEND_FAILED', 'SEND_UNKNOWN')),
        error TEXT,
        PRIMARY KEY (action_id, chat_id)
      ) STRICT;
    `);
    transaction(db, () => {
      if (!db.prepare("SELECT 1 FROM pragma_table_info('facts') WHERE name = 'conflict_card_sent'").get()) {
        db.exec("ALTER TABLE facts ADD COLUMN conflict_card_sent INTEGER NOT NULL DEFAULT 0");
      }
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export const selectFacts = `
  SELECT f.fact_key, f.questions, f.version, f.lock_state, f.confirmed, f.conflict_id,
    f.conflict_text, f.conflict_chat_id, f.conflict_message_id, f.conflict_timestamp,
    r.revision, r.text, r.effective_at
  FROM facts f JOIN fact_revisions r ON r.fact_key = f.fact_key AND r.revision = f.active_revision
`;
