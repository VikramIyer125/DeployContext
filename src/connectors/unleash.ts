/**
 * Live Unleash connector. evaluateAll answers "what flags does this customer
 * see?" by evaluating every known toggle under the customer's context with
 * the server SDK. getFlagMetadata uses the admin API.
 */
import { Unleash } from "unleash-client";
import type { Context } from "unleash-client";
import type { FlagContextRef } from "../domain/types.js";
import type { ConnectorResult, UnleashConnector } from "./types.js";
import { ok, err } from "./types.js";

export interface UnleashLiveOptions {
  url: string; // e.g. http://localhost:4242
  clientToken: string; // client API token (determines environment)
  adminToken?: string; // admin API token, needed for getFlagMetadata
  syncTimeoutMs?: number;
}

export class UnleashLiveConnector implements UnleashConnector {
  private client: Unleash | null = null;
  private sync: Promise<void> | null = null;

  constructor(private readonly opts: UnleashLiveOptions) {}

  private ensureClient(): Promise<void> {
    if (this.sync) return this.sync;
    const client = new Unleash({
      url: `${this.opts.url}/api/`,
      appName: "deploycontext",
      customHeaders: { Authorization: this.opts.clientToken },
      disableMetrics: true,
    });
    this.client = client;
    const timeoutMs = this.opts.syncTimeoutMs ?? 10_000;
    this.sync = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Unleash did not synchronize within ${timeoutMs}ms`)),
        timeoutMs,
      );
      client.once("synchronized", () => {
        clearTimeout(timer);
        resolve();
      });
      client.once("error", (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    return this.sync;
  }

  private toContext(ctx: FlagContextRef): Context {
    const { userId, environment, sessionId, remoteAddress, ...rest } = ctx.context;
    return {
      userId,
      environment,
      sessionId,
      remoteAddress,
      properties: rest,
    };
  }

  async evaluateAll(ctx: FlagContextRef): Promise<ConnectorResult<Record<string, boolean | string>>> {
    try {
      await this.ensureClient();
    } catch (e) {
      return err("unavailable", `Unleash unreachable: ${(e as Error).message}`);
    }
    const client = this.client!;
    const definitions = client.getFeatureToggleDefinitions() ?? [];
    const context = this.toContext(ctx);
    const result: Record<string, boolean | string> = {};
    for (const def of definitions) {
      result[def.name] = client.isEnabled(def.name, context);
    }
    return ok(result);
  }

  async getFlagMetadata(
    flag: string,
  ): Promise<ConnectorResult<{ description: string; createdAt: string; stale: boolean }>> {
    if (!this.opts.adminToken) {
      return err("auth", "no Unleash admin token configured (UNLEASH_ADMIN_TOKEN)");
    }
    let res: Response;
    try {
      res = await fetch(`${this.opts.url}/api/admin/projects/default/features/${encodeURIComponent(flag)}`, {
        headers: { Authorization: this.opts.adminToken },
      });
    } catch (e) {
      return err("unavailable", `Unleash unreachable: ${(e as Error).message}`);
    }
    if (res.status === 404) return err("not-found", `flag "${flag}" not found`);
    if (res.status === 401 || res.status === 403) return err("auth", `admin API: ${res.status}`);
    if (!res.ok) return err("unavailable", `admin API: ${res.status}`);
    const data = (await res.json()) as { description?: string; createdAt?: string; stale?: boolean };
    return ok({
      description: data.description ?? "",
      createdAt: data.createdAt ?? "",
      stale: data.stale ?? false,
    });
  }

  /** Stop background polling so the process can exit cleanly. */
  destroy(): void {
    this.client?.destroy();
  }
}
