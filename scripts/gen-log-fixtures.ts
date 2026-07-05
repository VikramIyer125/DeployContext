/**
 * Generates fixtures/logs.json — ~200 plausible app log lines across both
 * customers, including the smoking-gun errors for Acme's export bug.
 * Deterministic (seeded PRNG) so re-runs produce identical output.
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface LogLine {
  ts: string;
  level: "info" | "warn" | "error";
  service: string;
  customer: "acme" | "beta";
  version: string;
  message: string;
}

// mulberry32 — small deterministic PRNG
function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260705);
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

const WINDOW_START = Date.parse("2026-06-28T00:00:00Z");
const WINDOW_END = Date.parse("2026-07-05T18:00:00Z");

function randomTs(): string {
  return new Date(WINDOW_START + rand() * (WINDOW_END - WINDOW_START)).toISOString();
}

const version = (customer: "acme" | "beta"): string =>
  customer === "acme" ? "2.3.1" : "2.5.0";

const lines: LogLine[] = [];

// ---- Background noise: info/warn across services, both customers ----------
const NOISE: Array<{ service: string; level: "info" | "warn"; message: (c: string) => string }> = [
  { service: "api_gateway", level: "info", message: () => "GET /v1/exports 200 (34ms)" },
  { service: "api_gateway", level: "info", message: () => "GET /v1/invoices 200 (18ms)" },
  { service: "api_gateway", level: "info", message: () => "POST /v1/exports 202 (61ms)" },
  { service: "api_gateway", level: "warn", message: () => "slow response: GET /v1/reports (2140ms)" },
  { service: "auth_service", level: "info", message: (c) => `session refreshed — customer=${c}` },
  { service: "auth_service", level: "info", message: (c) => `SSO login ok — customer=${c}` },
  { service: "billing_worker", level: "info", message: (c) => `invoice batch settled — customer=${c}` },
  { service: "scheduler", level: "info", message: () => "nightly maintenance window opened" },
  { service: "scheduler", level: "info", message: () => "cron tick: cleanup_expired_sessions" },
  { service: "export_service", level: "info", message: (c) => `export started — customer=${c}` },
];

for (let i = 0; i < 150; i++) {
  const customer = rand() < 0.45 ? "acme" : "beta";
  const t = pick(NOISE);
  lines.push({
    ts: randomTs(),
    level: t.level,
    service: t.service,
    customer,
    version: version(customer),
    message: t.message(customer),
  });
}

// ---- Beta's exports succeed (healthy comparison) ---------------------------
for (let i = 0; i < 18; i++) {
  lines.push({
    ts: randomTs(),
    level: "info",
    service: "export_service",
    customer: "beta",
    version: "2.5.0",
    message: `exported ${100 + Math.floor(rand() * 300)} rows — customer=beta`,
  });
}

// ---- Unrelated sparse errors (decoys) --------------------------------------
const DECOY_ERRORS: Array<{ service: string; customer: "acme" | "beta"; message: string }> = [
  { service: "api_gateway", customer: "beta", message: "upstream timeout: reports-svc (5000ms)" },
  { service: "auth_service", customer: "acme", message: "SAML assertion clock skew — retried ok" },
  { service: "billing_worker", customer: "beta", message: "payment provider 503, will retry" },
];
for (const decoy of DECOY_ERRORS) {
  lines.push({
    ts: randomTs(),
    level: "error",
    service: decoy.service,
    customer: decoy.customer,
    version: version(decoy.customer),
    message: decoy.message,
  });
}

// ---- The smoking gun: Acme export failures in the report window ------------
const GUN_TIMES = [
  "2026-07-03T09:14:22Z",
  "2026-07-03T14:02:51Z",
  "2026-07-04T09:15:03Z",
  "2026-07-04T16:44:19Z",
  "2026-07-05T09:14:47Z",
  "2026-07-05T11:31:08Z",
];
for (const ts of GUN_TIMES) {
  lines.push({
    ts: new Date(Date.parse(ts) - 1200).toISOString(),
    level: "info",
    service: "export_service",
    customer: "acme",
    version: "2.3.1",
    message: "export started — customer=acme",
  });
  lines.push({
    ts,
    level: "error",
    service: "export_service",
    customer: "acme",
    version: "2.3.1",
    message:
      "cannot read field 'ledgerRef' — customer=acme version=2.3.1 flags=new_billing,!legacy_export",
  });
}

lines.sort((a, b) => a.ts.localeCompare(b.ts));

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "logs.json");
writeFileSync(out, JSON.stringify(lines, null, 2) + "\n");
console.log(`wrote ${lines.length} log lines to ${out}`);
