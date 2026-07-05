/**
 * In-memory UnleashConnector keyed by context userId.
 */
import type { FlagContextRef } from "../../domain/types.js";
import type { ConnectorResult, UnleashConnector } from "../types.js";
import { ok, err } from "../types.js";

export class FakeUnleash implements UnleashConnector {
  failWith: { reason: "auth" | "not-found" | "rate-limited" | "unavailable"; detail: string } | null =
    null;

  constructor(
    private readonly byUser: Record<string, Record<string, boolean | string>>,
    private readonly metadata: Record<
      string,
      { description: string; createdAt: string; stale: boolean }
    > = {},
  ) {}

  async evaluateAll(ctx: FlagContextRef): Promise<ConnectorResult<Record<string, boolean | string>>> {
    if (this.failWith) return err(this.failWith.reason, this.failWith.detail);
    const userId = ctx.context.userId;
    const flags = this.byUser[userId];
    if (!flags) return err("not-found", `no fake flag data for userId "${userId}"`);
    return ok({ ...flags });
  }

  async getFlagMetadata(
    flag: string,
  ): Promise<ConnectorResult<{ description: string; createdAt: string; stale: boolean }>> {
    if (this.failWith) return err(this.failWith.reason, this.failWith.detail);
    const meta = this.metadata[flag];
    if (!meta) return err("not-found", `flag "${flag}" not found`);
    return ok(meta);
  }
}
