/**
 * StateResolver — assembles a customer's ResolvedState by fanning out to the
 * registry (descriptors), Unleash (live flags), and GitHub (config at the
 * customer's ref). Every fact carries provenance. Partial failures degrade
 * into warnings, never crashes: the caller (and ultimately the LLM) receives
 * them as reasoning input.
 */
import { load } from "js-yaml";
import type { Attested, CustomerId, ResolvedState } from "../domain/types.js";
import type { ConnectorResult, GitHubConnector, UnleashConnector } from "../connectors/types.js";
import { ok, err } from "../connectors/types.js";
import type { Registry } from "../registry/registry.js";

export interface ResolveOutcome {
  state: ResolvedState;
  /** Human/LLM-readable notes about degraded facts (e.g. "flags unavailable"). */
  warnings: string[];
}

export interface StateResolverDeps {
  registry: Registry;
  github: GitHubConnector;
  unleash: UnleashConnector;
  /** Used to build provenance links for live flag evaluations. */
  unleashBaseUrl: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class StateResolver {
  constructor(private readonly deps: StateResolverDeps) {}

  async resolve(customer: CustomerId): Promise<ConnectorResult<ResolveOutcome>> {
    const { registry, github, unleash, unleashBaseUrl } = this.deps;

    const loaded = await registry.ensureLoaded();
    if (!loaded.ok) return err(loaded.reason, `registry unavailable: ${loaded.detail}`);

    const entry = registry.get(customer);
    if (!entry) {
      const known = registry.list().map((e) => e.customer).join(", ") || "(none)";
      return err("not-found", `unknown customer "${customer}" — registry knows: ${known}`);
    }

    const now = new Date().toISOString();
    const warnings: string[] = [];
    const ref = entry.code.ref.value;

    const [flagsRes, configRes] = await Promise.all([
      unleash.evaluateAll(entry.flagContext),
      entry.config
        ? github.readFile(entry.config.repo, ref, entry.config.path)
        : Promise.resolve(null),
    ]);

    let flags: Attested<Record<string, boolean | string>>;
    if (flagsRes.ok) {
      flags = {
        value: flagsRes.data,
        provenance: [
          {
            source: "unleash",
            evidenceUrl: `${unleashBaseUrl}/projects/default/features`,
            observedAt: now,
            confidence: "confirmed",
          },
        ],
      };
    } else {
      warnings.push(`flags unavailable (${flagsRes.reason}): ${flagsRes.detail}`);
      flags = { value: {}, provenance: [] };
    }

    let config: Attested<Record<string, unknown>> = { value: {}, provenance: [] };
    if (entry.config && configRes) {
      if (configRes.ok) {
        try {
          const parsed = load(configRes.data);
          if (!isRecord(parsed)) throw new Error("config is not a mapping");
          config = {
            value: parsed,
            provenance: [
              {
                source: "github",
                evidenceUrl: `https://github.com/${entry.config.repo}/blob/${ref}/${entry.config.path}`,
                observedAt: now,
                confidence: "confirmed",
              },
            ],
          };
        } catch (e) {
          warnings.push(`config unparseable at ${entry.config.path}@${ref}: ${(e as Error).message}`);
        }
      } else {
        warnings.push(`config unavailable (${configRes.reason}): ${configRes.detail}`);
      }
    }

    const state: ResolvedState = {
      customer,
      resolvedAt: now,
      version: entry.versionPin,
      flags,
      config,
    };
    return ok({ state, warnings });
  }
}
