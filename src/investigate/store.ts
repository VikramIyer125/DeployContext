/**
 * InvestigationStore — SQLite-backed working memory. Disposable by design:
 * losing it loses no truth (the registry manifest in git is the only truth).
 * Keyed by Slack thread for continuity.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Diagnosis, Evidence, Investigation } from "../domain/types.js";

interface Row {
  id: string;
  channel: string;
  thread_ts: string;
  permalink: string;
  trigger_text: string;
  customer: string;
  status: Investigation["status"];
  evidence: string;
  diagnosis: string | null;
  pending_context: string;
}

export class InvestigationStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS investigations (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        permalink TEXT NOT NULL,
        trigger_text TEXT NOT NULL,
        customer TEXT NOT NULL,
        status TEXT NOT NULL,
        evidence TEXT NOT NULL DEFAULT '[]',
        diagnosis TEXT,
        pending_context TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_inv_thread ON investigations (channel, thread_ts);
    `);
  }

  create(input: {
    trigger: Investigation["trigger"];
    customer: string;
  }): Investigation {
    const inv: Investigation = {
      id: randomUUID().slice(0, 8),
      trigger: input.trigger,
      customer: input.customer,
      evidence: [],
      status: "running",
    };
    this.db
      .prepare(
        `INSERT INTO investigations (id, channel, thread_ts, permalink, trigger_text, customer, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        inv.id,
        inv.trigger.channel,
        inv.trigger.threadTs,
        inv.trigger.permalink,
        inv.trigger.text,
        inv.customer,
        inv.status,
      );
    return inv;
  }

  private fromRow(row: Row): Investigation {
    return {
      id: row.id,
      trigger: {
        channel: row.channel,
        threadTs: row.thread_ts,
        permalink: row.permalink,
        text: row.trigger_text,
      },
      customer: row.customer,
      evidence: JSON.parse(row.evidence) as Evidence[],
      diagnosis: row.diagnosis ? (JSON.parse(row.diagnosis) as Diagnosis) : undefined,
      status: row.status,
    };
  }

  get(id: string): Investigation | undefined {
    const row = this.db.prepare(`SELECT * FROM investigations WHERE id = ?`).get(id) as
      | Row
      | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  /** Latest investigation attached to a Slack thread (thread continuity). */
  byThread(channel: string, threadTs: string): Investigation | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM investigations WHERE channel = ? AND thread_ts = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(channel, threadTs) as Row | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  saveEvidence(id: string, evidence: Evidence[]): void {
    this.db
      .prepare(
        `UPDATE investigations SET evidence = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      )
      .run(JSON.stringify(evidence), id);
  }

  saveDiagnosis(id: string, diagnosis: Diagnosis, status: Investigation["status"]): void {
    this.db
      .prepare(
        `UPDATE investigations SET diagnosis = ?, status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      )
      .run(JSON.stringify(diagnosis), status, id);
  }

  setStatus(id: string, status: Investigation["status"]): void {
    this.db
      .prepare(
        `UPDATE investigations SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      )
      .run(status, id);
  }

  /** Human replies posted into the thread while the investigation runs. */
  pushContext(id: string, message: string): void {
    const row = this.db.prepare(`SELECT pending_context FROM investigations WHERE id = ?`).get(id) as
      | { pending_context: string }
      | undefined;
    if (!row) return;
    const ctx = JSON.parse(row.pending_context) as string[];
    ctx.push(message);
    this.db
      .prepare(`UPDATE investigations SET pending_context = ? WHERE id = ?`)
      .run(JSON.stringify(ctx), id);
  }

  /** Drain queued human context (returns and clears). */
  drainContext(id: string): string[] {
    const row = this.db.prepare(`SELECT pending_context FROM investigations WHERE id = ?`).get(id) as
      | { pending_context: string }
      | undefined;
    if (!row) return [];
    const ctx = JSON.parse(row.pending_context) as string[];
    if (ctx.length > 0) {
      this.db.prepare(`UPDATE investigations SET pending_context = '[]' WHERE id = ?`).run(id);
    }
    return ctx;
  }

  close(): void {
    this.db.close();
  }
}
