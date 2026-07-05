/**
 * Shared offline test world mirroring the seeded demo environment: Acme
 * pinned to a buggy tag with the bug flag combo, Beta healthy on main.
 */
import type { Attested, ResolvedState } from "../src/domain/types.js";
import { FakeGitHub, FakeUnleash } from "../src/connectors/fakes/index.js";
import { Registry } from "../src/registry/registry.js";
import { ok } from "../src/connectors/types.js";

export const TEST_MANIFEST = `# deployments.yaml — maintained by DeployContext. Edit via PR.
customers:
  acme:
    displayName: Acme Corp
    code: { repo: yourco/fake-product, refType: tag, ref: acme-prod-v2.3.1 }
    versionPin: v2.3.1
    flagContext: { provider: unleash, context: { userId: acme, environment: production } }
    config: { repo: yourco/fake-product, path: customers/acme/values.yaml }
    slackChannels: [C0123ACME]
    notes:
      - "Runs pinned; upgrade window is quarterly, next in Sept."
    provenance:
      versionPin:
        source: human
        evidenceUrl: "https://yourco.slack.com/archives/C1/p1"
        observedAt: "2026-06-12"
        confidence: confirmed
      ref:
        source: slack
        evidenceUrl: "https://yourco.slack.com/archives/C1/p2"
        observedAt: "2026-05-03"
        confidence: inferred-high
  beta:
    displayName: Beta Industries
    code: { repo: yourco/fake-product, refType: branch, ref: main }
    versionPin: v2.5.0
    flagContext: { provider: unleash, context: { userId: beta, environment: production } }
    config: { repo: yourco/fake-product, path: customers/beta/values.yaml }
    slackChannels: []
    notes: []
`;

export const ACME_VALUES_YAML = `export:
  delimiter: ","
  batchSize: 500
  includeHeader: false
region: us-east-1
support:
  tier: enterprise
`;

export const BETA_VALUES_YAML = `export:
  delimiter: "|"
  batchSize: 100
  includeHeader: true
region: eu-west-1
support:
  tier: standard
`;

export const ACME_FLAGS: Record<string, boolean | string> = {
  new_billing: true,
  legacy_export: false,
  dark_mode_v2: true,
  audit_log_v2: true,
  sso_enforced: true,
  rate_limiter_v2: true,
  beta_dashboard: false,
  csv_streaming: false,
  new_onboarding: false,
  export_parallelism: false,
};

export const BETA_FLAGS: Record<string, boolean | string> = {
  ...ACME_FLAGS,
  new_billing: false,
  legacy_export: true,
  beta_dashboard: true,
};

export function buildTestWorld() {
  const github = new FakeGitHub({
    refs: [
      { name: "main", type: "branch", lastCommitAt: "2026-06-24T23:05:00Z" },
      { name: "acme-prod-v2.3.1", type: "tag", lastCommitAt: "2026-05-02T21:03:00Z" },
      { name: "v2.3.1", type: "tag", lastCommitAt: "2026-05-02T21:03:00Z" },
      { name: "v2.5.0", type: "tag", lastCommitAt: "2026-06-10T16:40:00Z" },
    ],
    files: {
      main: {
        "deployments.yaml": TEST_MANIFEST,
        "customers/acme/values.yaml": ACME_VALUES_YAML,
        "customers/beta/values.yaml": BETA_VALUES_YAML,
      },
      "acme-prod-v2.3.1": {
        "customers/acme/values.yaml": ACME_VALUES_YAML,
        "customers/beta/values.yaml": BETA_VALUES_YAML,
      },
    },
  });

  const unleash = new FakeUnleash(
    { acme: { ...ACME_FLAGS }, beta: { ...BETA_FLAGS } },
    {
      new_billing: {
        description: "New-billing export format (rolling out per customer)",
        createdAt: "2026-04-28T00:00:00Z",
        stale: false,
      },
      legacy_export: {
        description: "Legacy export pipeline (being phased out)",
        createdAt: "2024-01-10T00:00:00Z",
        stale: false,
      },
    },
  );

  const registry = new Registry(async () => ok(TEST_MANIFEST));
  return { github, unleash, registry };
}

export function attested<T>(value: T): Attested<T> {
  return { value, provenance: [] };
}

export function makeState(partial: {
  customer: string;
  version?: string;
  flags?: Record<string, boolean | string>;
  config?: Record<string, unknown>;
}): ResolvedState {
  return {
    customer: partial.customer,
    resolvedAt: "2026-07-05T00:00:00Z",
    version: attested(partial.version ?? "v1.0.0"),
    flags: attested(partial.flags ?? {}),
    config: attested(partial.config ?? {}),
  };
}
