/**
 * M5 exit test (deploy-watch half): REAL Haiku classifier + REAL registry
 * write path against the live fake-product manifest.
 *
 * 1. classify the storyboard announcement ("shipped v2.5 to Acme 🚀") → hit
 * 2. classify decoys (staging deploy, lunch chatter) → misses
 * 3. draft the bump proposal and APPLY it (real commit to the manifest)
 * 4. verify the manifest on GitHub changed, then apply the reverse bump to
 *    restore the demo world (acme pinned at acme-prod-v2.3.1 / v2.3.1)
 *
 * Usage: npx tsx scripts/run-deploywatch.ts
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { classifyDeployMessage, draftBumpProposal } from "../src/deploywatch/listener.js";
import { ProposalStore } from "../src/registry/proposals.js";
import { RegistryManager } from "../src/registry/manager.js";
import { Registry, githubManifestLoader } from "../src/registry/registry.js";
import { GitHubLiveConnector } from "../src/connectors/github.js";

const { ANTHROPIC_API_KEY, GITHUB_TOKEN } = process.env;
if (!ANTHROPIC_API_KEY || !GITHUB_TOKEN) {
  console.error("ANTHROPIC_API_KEY and GITHUB_TOKEN required (fill .env)");
  process.exit(1);
}
const GITHUB_REPO = process.env.GITHUB_REPO ?? "VikramIyer125/fake-product";
const MANIFEST_PATH = process.env.MANIFEST_PATH ?? "deployments.yaml";

const ANNOUNCEMENT = "shipped v2.5 to Acme 🚀 — they're off the pin, tracking tag v2.5.0 now";
const DECOYS = [
  "Deploy complete: v2.4.0 → staging (2026-05-20).",
  "lunch train to the taco place leaves at 12:30 sharp",
];

async function main(): Promise<void> {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const github = new GitHubLiveConnector(GITHUB_TOKEN!);
  const registry = new Registry(githubManifestLoader(github, GITHUB_REPO, "main", MANIFEST_PATH));
  const proposals = new ProposalStore(":memory:");
  const manager = new RegistryManager({ github, registry, repo: GITHUB_REPO, manifestPath: MANIFEST_PATH });
  await registry.ensureLoaded();

  const failures: string[] = [];

  // 1. the storyboard announcement classifies as a hit
  const hit = await classifyDeployMessage(anthropic, ANNOUNCEMENT);
  console.log("announcement →", JSON.stringify(hit));
  if (!hit.isAnnouncement || hit.customer !== "acme") failures.push("announcement not classified as acme deploy");

  // 2. decoys classify as misses
  for (const decoy of DECOYS) {
    const miss = await classifyDeployMessage(anthropic, decoy);
    console.log(`decoy "${decoy.slice(0, 40)}…" →`, JSON.stringify(miss));
    if (miss.isAnnouncement && miss.customer) failures.push(`decoy classified as announcement: ${decoy}`);
  }

  // 3. draft + APPLY the bump (real manifest commit)
  const proposal = draftBumpProposal({
    announcement: hit,
    registry,
    proposals,
    permalink: "https://hackathonsandbox.slack.com/archives/C0BEUB621F1/p-demo-bump",
  });
  if (!proposal) {
    failures.push("no proposal drafted");
  } else {
    console.log(`\nproposal ${proposal.id}: ${JSON.stringify(proposal.change)}`);
    const applied = await manager.apply(proposal);
    if (!applied.ok) {
      failures.push(`apply failed: ${applied.detail}`);
    } else {
      console.log(`applied (${applied.data.mode}): ${applied.data.url}`);
      const after = registry.get("acme");
      console.log(`registry now: acme pin=${after?.versionPin.value} ref=${after?.code.ref.value}`);
      if (after?.versionPin.value !== (hit.version ?? "v2.5.0") && after?.code.ref.value !== hit.ref) {
        failures.push("manifest did not change as proposed");
      }

      // 4. restore the demo world with the reverse bump (same write path)
      const restore = proposals.create({
        kind: "version-bump",
        customer: "acme",
        change: { versionPin: "v2.3.1", ref: "acme-prod-v2.3.1" },
        provenance: [
          {
            source: "human",
            evidenceUrl: "",
            observedAt: new Date().toISOString(),
            confidence: "confirmed",
          },
        ],
      });
      const restored = await manager.apply(restore);
      if (!restored.ok) {
        failures.push(`RESTORE FAILED — fix manually! ${restored.detail}`);
      } else {
        const finalState = registry.get("acme");
        console.log(`restored (cache): acme pin=${finalState?.versionPin.value} ref=${finalState?.code.ref.value}`);
        if (finalState?.versionPin.value !== "v2.3.1" || finalState?.code.ref.value !== "acme-prod-v2.3.1") {
          failures.push("demo world not restored to the pinned state");
        }
        // Verify REMOTE truth too — GitHub reads can lag, so poll briefly.
        let remoteOk = false;
        for (let attempt = 0; attempt < 12 && !remoteOk; attempt++) {
          const raw = await github.readFile(GITHUB_REPO, "main", MANIFEST_PATH);
          if (raw.ok && raw.data.includes("versionPin: v2.3.1") && raw.data.includes("ref: acme-prod-v2.3.1")) {
            remoteOk = true;
          } else {
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
        console.log(`restored (remote manifest): ${remoteOk ? "verified" : "NOT verified"}`);
        if (!remoteOk) failures.push("remote manifest not restored (checked for 60s)");
      }
    }
  }

  console.log(failures.length === 0 ? "\n✓ PASS: announcement → bump proposal → applied → restored" : `\n✗ FAIL: ${failures.join("; ")}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
