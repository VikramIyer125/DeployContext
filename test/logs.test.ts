import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeededLogSource } from "../src/connectors/logs.js";
import type { LogLine } from "../src/connectors/types.js";

const FIXTURE_PATH = join(process.cwd(), "fixtures", "logs.json");

function tempFixture(lines: LogLine[]): string {
  const dir = mkdtempSync(join(tmpdir(), "dc-logs-"));
  const p = join(dir, "logs.json");
  writeFileSync(p, JSON.stringify(lines));
  return p;
}

const WIDE_WINDOW = { from: "2026-06-01T00:00:00Z", to: "2026-08-01T00:00:00Z" };

describe("SeededLogSource (rebase off)", () => {
  it("finds the smoking gun in the checked-in fixture", async () => {
    const source = new SeededLogSource(FIXTURE_PATH, { rebaseToNow: false });
    const res = await source.query({ customer: "acme", level: "error", window: WIDE_WINDOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 6 ledgerRef errors + 1 decoy SAML error
    expect(res.data.matchCount).toBe(7);
    expect(res.data.topPatterns[0].pattern).toContain("cannot read field 'ledgerRef'");
    expect(res.data.topPatterns[0].count).toBe(6);
    expect(res.data.sample.length).toBeLessThanOrEqual(10);
    expect(res.data.sample.every((l) => l.customer === "acme" && l.level === "error")).toBe(true);
  });

  it("narrows by text filter", async () => {
    const source = new SeededLogSource(FIXTURE_PATH, { rebaseToNow: false });
    const res = await source.query({ text: "ledgerRef", window: WIDE_WINDOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.matchCount).toBe(6);
    expect(res.data.timeRange).not.toBeNull();
  });

  it("caps the sample at 10 and returns most recent first", async () => {
    const source = new SeededLogSource(FIXTURE_PATH, { rebaseToNow: false });
    const res = await source.query({ window: WIDE_WINDOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.matchCount).toBeGreaterThan(100);
    expect(res.data.sample).toHaveLength(10);
    const ts = res.data.sample.map((l) => l.ts);
    expect([...ts].sort().reverse()).toEqual(ts);
  });

  it("filters by window", async () => {
    const lines: LogLine[] = [
      { ts: "2026-07-01T00:00:00Z", level: "info", service: "s", customer: "acme", version: "1", message: "inside" },
      { ts: "2026-07-09T00:00:00Z", level: "info", service: "s", customer: "acme", version: "1", message: "outside" },
    ];
    const source = new SeededLogSource(tempFixture(lines), { rebaseToNow: false });
    const res = await source.query({ window: { from: "2026-06-30T00:00:00Z", to: "2026-07-02T00:00:00Z" } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.matchCount).toBe(1);
    expect(res.data.sample[0].message).toBe("inside");
  });

  it("returns matchCount 0 and null timeRange when nothing matches", async () => {
    const source = new SeededLogSource(FIXTURE_PATH, { rebaseToNow: false });
    const res = await source.query({ text: "no-such-string-anywhere", window: WIDE_WINDOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({ matchCount: 0, timeRange: null, topPatterns: [], sample: [] });
  });

  it("returns unavailable for a missing fixture file", async () => {
    const source = new SeededLogSource("/nonexistent/logs.json");
    const res = await source.query({ window: WIDE_WINDOW });
    expect(res).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("returns unavailable for an invalid window", async () => {
    const source = new SeededLogSource(FIXTURE_PATH, { rebaseToNow: false });
    const res = await source.query({ window: { from: "garbage", to: "2026-07-01T00:00:00Z" } });
    expect(res).toMatchObject({ ok: false, reason: "unavailable" });
  });
});

describe("SeededLogSource (rebase on)", () => {
  it("shifts fixture timestamps so the newest line is ~1h ago", async () => {
    const source = new SeededLogSource(FIXTURE_PATH, { rebaseToNow: true });
    const now = Date.now();
    const res = await source.query({
      window: { from: new Date(now - 14 * 24 * 3600 * 1000).toISOString(), to: new Date(now).toISOString() },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.matchCount).toBeGreaterThan(100);
    const newest = Date.parse(res.data.sample[0].ts);
    expect(now - newest).toBeGreaterThan(50 * 60 * 1000);
    expect(now - newest).toBeLessThan(70 * 60 * 1000);
  });

  it("keeps the smoking gun findable in a last-48h window", async () => {
    const source = new SeededLogSource(FIXTURE_PATH, { rebaseToNow: true });
    const now = Date.now();
    const res = await source.query({
      customer: "acme",
      level: "error",
      text: "ledgerRef",
      window: { from: new Date(now - 48 * 3600 * 1000).toISOString(), to: new Date(now).toISOString() },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.matchCount).toBeGreaterThanOrEqual(1);
  });
});
