/**
 * ProposalStore — pending unconfirmed beliefs with provenance, plus the Slack
 * ts of their confirm card (§3 storage tiers). SQLite working memory;
 * disposable. Truth only ever changes via RegistryManager → git.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { CustomerId, Provenance, RegistryEntry } from "../domain/types.js";

export type ProposalKind = "new-customer" | "version-bump";

export interface Proposal {
  id: string;
  kind: ProposalKind;
  customer: CustomerId;
  /** Full proposed entry (new-customer). */
  entry?: RegistryEntry;
  /** Partial change (version-bump). */
  change?: { versionPin?: string; ref?: string };
  provenance: Provenance[];
  status: "pending" | "confirmed" | "rejected" | "applied";
  /** Slack location of the confirm card, once posted. */
  confirmCard?: { channel: string; ts: string };
  createdAt: string;
}

interface Row {
  id: string;
  kind: ProposalKind;
  customer: string;
  payload: string;
  status: Proposal["status"];
  card_channel: string | null;
  card_ts: string | null;
  created_at: string;
}

export class ProposalStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        customer TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        card_channel TEXT,
        card_ts TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
  }

  create(input: {
    kind: ProposalKind;
    customer: CustomerId;
    entry?: RegistryEntry;
    change?: Proposal["change"];
    provenance: Provenance[];
  }): Proposal {
    const proposal: Proposal = {
      id: randomUUID().slice(0, 8),
      kind: input.kind,
      customer: input.customer,
      entry: input.entry,
      change: input.change,
      provenance: input.provenance,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(`INSERT INTO proposals (id, kind, customer, payload, status) VALUES (?, ?, ?, ?, ?)`)
      .run(
        proposal.id,
        proposal.kind,
        proposal.customer,
        JSON.stringify({ entry: proposal.entry, change: proposal.change, provenance: proposal.provenance }),
        proposal.status,
      );
    return proposal;
  }

  private fromRow(row: Row): Proposal {
    const payload = JSON.parse(row.payload) as Pick<Proposal, "entry" | "change" | "provenance">;
    return {
      id: row.id,
      kind: row.kind,
      customer: row.customer,
      entry: payload.entry,
      change: payload.change,
      provenance: payload.provenance ?? [],
      status: row.status,
      confirmCard:
        row.card_channel && row.card_ts ? { channel: row.card_channel, ts: row.card_ts } : undefined,
      createdAt: row.created_at,
    };
  }

  get(id: string): Proposal | undefined {
    const row = this.db.prepare(`SELECT * FROM proposals WHERE id = ?`).get(id) as Row | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  setCard(id: string, channel: string, ts: string): void {
    this.db.prepare(`UPDATE proposals SET card_channel = ?, card_ts = ? WHERE id = ?`).run(channel, ts, id);
  }

  setStatus(id: string, status: Proposal["status"]): void {
    this.db.prepare(`UPDATE proposals SET status = ? WHERE id = ?`).run(status, id);
  }

  pending(): Proposal[] {
    const rows = this.db.prepare(`SELECT * FROM proposals WHERE status = 'pending' ORDER BY created_at`).all() as Row[];
    return rows.map((r) => this.fromRow(r));
  }

  close(): void {
    this.db.close();
  }
}
