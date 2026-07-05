/**
 * Canned SlackSearch for offline tests. Results are matched by substring
 * against the query; every query is recorded for assertions.
 */
import type { ConnectorResult, SlackSearch, SlackSearchResult } from "../types.js";
import { ok, err } from "../types.js";

export interface CannedSearchEntry {
  /** Result is returned when the query contains this substring ("" = always). */
  matches: string;
  results: SlackSearchResult[];
}

export class FakeSlackSearch implements SlackSearch {
  queries: Array<{ query: string; opts?: { channels?: string[]; before?: string; after?: string } }> =
    [];
  failWith: { reason: "auth" | "not-found" | "rate-limited" | "unavailable"; detail: string } | null =
    null;

  constructor(private readonly canned: CannedSearchEntry[] = []) {}

  async search(
    query: string,
    opts?: { channels?: string[]; before?: string; after?: string },
  ): Promise<ConnectorResult<SlackSearchResult[]>> {
    this.queries.push({ query, opts });
    if (this.failWith) return err(this.failWith.reason, this.failWith.detail);
    const q = query.toLowerCase();
    const results = this.canned
      .filter((c) => c.matches === "" || q.includes(c.matches.toLowerCase()))
      .flatMap((c) => c.results);
    return ok(results);
  }
}
