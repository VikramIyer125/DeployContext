/**
 * In-memory registry cache. Derived, rebuildable, never authoritative —
 * truth lives in the git manifest (deployments.yaml).
 */
import type { CustomerId, RegistryEntry } from "../domain/types.js";
import type { ConnectorResult, GitHubConnector } from "../connectors/types.js";
import { ok, err } from "../connectors/types.js";
import { parseManifest } from "./manifest.js";

export type ManifestLoader = () => Promise<ConnectorResult<string>>;

export function githubManifestLoader(
  gh: GitHubConnector,
  repo: string,
  ref: string,
  path: string,
): ManifestLoader {
  return () => gh.readFile(repo, ref, path);
}

export class Registry {
  private entries = new Map<CustomerId, RegistryEntry>();
  private loadedAt: string | null = null;

  constructor(private readonly loader: ManifestLoader) {}

  async refresh(): Promise<ConnectorResult<void>> {
    const res = await this.loader();
    if (!res.ok) return res;
    try {
      const entries = parseManifest(res.data);
      this.entries = new Map(entries.map((e) => [e.customer, e]));
      this.loadedAt = new Date().toISOString();
      return ok(undefined);
    } catch (e) {
      return err("unavailable", `manifest parse failed: ${(e as Error).message}`);
    }
  }

  async ensureLoaded(): Promise<ConnectorResult<void>> {
    if (this.loadedAt !== null) return ok(undefined);
    return this.refresh();
  }

  get isLoaded(): boolean {
    return this.loadedAt !== null;
  }

  get(customer: CustomerId): RegistryEntry | undefined {
    return this.entries.get(customer);
  }

  list(): RegistryEntry[] {
    return [...this.entries.values()];
  }

  /** Channel → customer mapping; triage's highest-priority resolution rule. */
  byChannel(channelId: string): RegistryEntry | undefined {
    return this.list().find((e) => (e.slackChannels ?? []).includes(channelId));
  }
}
