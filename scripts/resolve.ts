/**
 * Dev CLI: resolve a customer's state against the REAL Unleash + GitHub.
 * M1 exit test and a handy smoke check.
 *
 * Usage:
 *   GITHUB_TOKEN=$(gh auth token) npx tsx scripts/resolve.ts acme
 *   GITHUB_TOKEN=$(gh auth token) npx tsx scripts/resolve.ts acme --diff beta
 */
import "dotenv/config";
import { GitHubLiveConnector } from "../src/connectors/github.js";
import { UnleashLiveConnector } from "../src/connectors/unleash.js";
import { Registry, githubManifestLoader } from "../src/registry/registry.js";
import { StateResolver } from "../src/resolve/resolver.js";
import { diff } from "../src/resolve/diff.js";
import type { ResolvedState } from "../src/domain/types.js";

const customer = process.argv[2];
const diffWith = process.argv[3] === "--diff" ? process.argv[4] : undefined;
if (!customer) {
  console.error("usage: tsx scripts/resolve.ts <customer> [--diff <other>]");
  process.exit(1);
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN required (dev: GITHUB_TOKEN=$(gh auth token))");
  process.exit(1);
}
const GITHUB_REPO = process.env.GITHUB_REPO ?? "VikramIyer125/fake-product";
const UNLEASH_URL = process.env.UNLEASH_URL ?? "http://localhost:4242";
const UNLEASH_API_TOKEN =
  process.env.UNLEASH_API_TOKEN ?? "default:production.deploycontext-insecure-client-token";
const MANIFEST_PATH = process.env.MANIFEST_PATH ?? "deployments.yaml";

const github = new GitHubLiveConnector(GITHUB_TOKEN);
const unleash = new UnleashLiveConnector({ url: UNLEASH_URL, clientToken: UNLEASH_API_TOKEN });
const registry = new Registry(githubManifestLoader(github, GITHUB_REPO, "main", MANIFEST_PATH));
const resolver = new StateResolver({ registry, github, unleash, unleashBaseUrl: UNLEASH_URL });

function printState(state: ResolvedState, warnings: string[]): void {
  console.log(`\n=== ${state.customer} (resolved ${state.resolvedAt}) ===`);
  console.log(`version: ${state.version.value}`);
  for (const p of state.version.provenance) {
    console.log(`  ↳ ${p.source} ${p.confidence} ${p.observedAt} ${p.evidenceUrl || "(no url)"}`);
  }
  console.log(`flags (${Object.keys(state.flags.value).length} evaluated live):`);
  for (const [flag, value] of Object.entries(state.flags.value).sort()) {
    console.log(`  ${flag} = ${value}`);
  }
  for (const p of state.flags.provenance) {
    console.log(`  ↳ ${p.source} ${p.confidence} ${p.observedAt} ${p.evidenceUrl}`);
  }
  console.log("config:");
  console.log(
    JSON.stringify(state.config.value, null, 2)
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
  );
  for (const p of state.config.provenance) {
    console.log(`  ↳ ${p.source} ${p.confidence} ${p.observedAt} ${p.evidenceUrl}`);
  }
  for (const w of warnings) console.log(`⚠ ${w}`);
}

async function main(): Promise<void> {
  const res = await resolver.resolve(customer);
  if (!res.ok) {
    console.error(`resolve failed: [${res.reason}] ${res.detail}`);
    process.exit(1);
  }
  printState(res.data.state, res.data.warnings);

  if (diffWith) {
    const other = await resolver.resolve(diffWith);
    if (!other.ok) {
      console.error(`resolve ${diffWith} failed: [${other.reason}] ${other.detail}`);
      process.exit(1);
    }
    printState(other.data.state, other.data.warnings);
    console.log(`\n=== diff(${customer}, ${diffWith}) ===`);
    console.log(JSON.stringify(diff(res.data.state, other.data.state), null, 2));
  }

  unleash.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
