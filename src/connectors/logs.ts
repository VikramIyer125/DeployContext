/**
 * SeededLogSource — LogSource implementation reading JSON fixtures.
 * Real backends (Datadog, CloudWatch, …) are drop-in replacements later.
 *
 * Results are size-curated per §4 rule 5: counts + patterns + a sample of at
 * most 10 lines, never a raw dump.
 */
import { readFileSync } from "node:fs";
import type { ConnectorResult, LogLine, LogQuery, LogQuerySummary, LogSource } from "./types.js";
import { ok, err } from "./types.js";

export interface SeededLogSourceOptions {
  /**
   * Shift all fixture timestamps so the newest line is ~1h before process
   * start. Keeps the seeded incident inside "the report window" no matter
   * when the demo runs. Default true.
   */
  rebaseToNow?: boolean;
}

const SAMPLE_LIMIT = 10;
const TOP_PATTERNS = 5;

export class SeededLogSource implements LogSource {
  private lines: LogLine[] | null = null;
  private loadError: string | null = null;

  constructor(
    private readonly fixturePath: string,
    private readonly opts: SeededLogSourceOptions = {},
  ) {}

  private load(): LogLine[] {
    if (this.lines) return this.lines;
    const raw = JSON.parse(readFileSync(this.fixturePath, "utf8")) as LogLine[];
    if (!Array.isArray(raw)) throw new Error("log fixture must be a JSON array");
    let lines = raw;
    if (this.opts.rebaseToNow !== false && raw.length > 0) {
      const maxTs = Math.max(...raw.map((l) => Date.parse(l.ts)));
      const shift = Date.now() - 60 * 60 * 1000 - maxTs;
      lines = raw.map((l) => ({ ...l, ts: new Date(Date.parse(l.ts) + shift).toISOString() }));
    }
    this.lines = lines.sort((a, b) => a.ts.localeCompare(b.ts));
    return this.lines;
  }

  async query(q: LogQuery): Promise<ConnectorResult<LogQuerySummary>> {
    let lines: LogLine[];
    try {
      lines = this.load();
    } catch (e) {
      return err("unavailable", `cannot read log fixtures at ${this.fixturePath}: ${(e as Error).message}`);
    }

    const from = Date.parse(q.window.from);
    const to = Date.parse(q.window.to);
    if (Number.isNaN(from) || Number.isNaN(to)) {
      return err("unavailable", `invalid window: from=${q.window.from} to=${q.window.to}`);
    }

    const needle = q.text?.toLowerCase();
    const matches = lines.filter((l) => {
      const t = Date.parse(l.ts);
      if (t < from || t > to) return false;
      if (q.customer && l.customer !== q.customer) return false;
      if (q.level && l.level !== q.level) return false;
      if (needle && !l.message.toLowerCase().includes(needle)) return false;
      return true;
    });

    return ok({
      matchCount: matches.length,
      timeRange:
        matches.length === 0
          ? null
          : { from: matches[0].ts, to: matches[matches.length - 1].ts },
      topPatterns: topPatterns(matches),
      sample: matches.slice(-SAMPLE_LIMIT).reverse(), // most recent first
    });
  }
}

/** Cluster messages by shape (digits collapsed) and count the top patterns. */
function topPatterns(lines: LogLine[]): Array<{ pattern: string; count: number }> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const pattern = `${line.level.toUpperCase()} ${line.service}: ${line.message.replace(/\d+/g, "#")}`;
    counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, TOP_PATTERNS)
    .map(([pattern, count]) => ({ pattern, count }));
}
