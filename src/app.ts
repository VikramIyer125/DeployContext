/**
 * DeployContext — Slack socket-mode app: router, fast query path, action
 * handlers. The expensive loop is never the front door: one cheap Haiku
 * triage call dispatches every mention.
 */
import "dotenv/config";
import boltPkg from "@slack/bolt";
import Anthropic from "@anthropic-ai/sdk";
import type { WebClient } from "@slack/web-api";
import { loadConfig, EnvError } from "./env.js";
import { log } from "./log.js";
import { GitHubLiveConnector } from "./connectors/github.js";
import { UnleashLiveConnector } from "./connectors/unleash.js";
import { SeededLogSource } from "./connectors/logs.js";
import { RtsSlackSearch, LatestActionTokenStore } from "./connectors/slackSearch.js";
import { Registry, githubManifestLoader } from "./registry/registry.js";
import { StateResolver } from "./resolve/resolver.js";
import { triage, resolveCustomer, type ThreadMessage } from "./triage.js";
import { formatState, clarifyCustomer } from "./slack/format.js";

const { App } = boltPkg;

function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").replace(/\s+/g, " ").trim();
}

async function fetchThreadContext(
  client: WebClient,
  channel: string,
  threadTs: string,
  excludeTs: string,
): Promise<ThreadMessage[]> {
  try {
    const res = await client.conversations.replies({ channel, ts: threadTs, limit: 12 });
    const messages = (res.messages ?? []).filter((m) => m.ts !== excludeTs);
    const parent = messages[0];
    const tail = messages.slice(1).slice(-10);
    return [parent, ...tail]
      .filter((m): m is NonNullable<typeof m> => Boolean(m))
      .map((m) => ({
        author: (m as { username?: string }).username ?? m.user ?? "unknown",
        text: (m.text ?? "").slice(0, 500),
      }));
  } catch (e) {
    log.warn("could not fetch thread context", { error: (e as Error).message });
    return [];
  }
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof EnvError) {
      console.error(`\n✗ ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  // ---- Layer 1: connectors -------------------------------------------------
  const github = new GitHubLiveConnector(config.githubToken);
  const unleash = new UnleashLiveConnector({
    url: config.unleashUrl,
    clientToken: config.unleashApiToken,
    adminToken: config.unleashAdminToken,
  });
  const logSource = new SeededLogSource(config.logFixturesPath);
  const tokenStore = new LatestActionTokenStore();
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

  const registry = new Registry(
    githubManifestLoader(github, config.githubRepo, "main", config.manifestPath),
  );
  const resolver = new StateResolver({
    registry,
    github,
    unleash,
    unleashBaseUrl: config.unleashUrl,
  });

  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
    logLevel: "warn" as never,
  });
  const slackSearch = new RtsSlackSearch(app.client, tokenStore);
  void slackSearch; // wired into the investigation loop in M3, bootstrap in M5
  void logSource;

  // ---- Router ---------------------------------------------------------------
  app.event("app_mention", async ({ event, client, say }) => {
    const ev = event as typeof event & { action_token?: string };
    tokenStore.set(ev.action_token);
    const started = Date.now();
    const threadTs = ev.thread_ts ?? ev.ts;

    try {
      const text = stripMentions(ev.text ?? "");
      const threadContext = ev.thread_ts
        ? await fetchThreadContext(client, ev.channel, ev.thread_ts, ev.ts)
        : [];
      const intent = await triage(anthropic, { text, threadContext });
      log.info("triage", { text: text.slice(0, 80), ...intent, ms: Date.now() - started });

      await registry.ensureLoaded();
      const resolution = resolveCustomer({
        channelId: ev.channel,
        extracted: intent.customer,
        registry,
      });

      switch (intent.mode) {
        case "query": {
          if (resolution.kind === "ask") {
            await say({
              text: clarifyCustomer(registry.list().map((e) => e.customer)),
              thread_ts: threadTs,
            });
            return;
          }
          const res = await resolver.resolve(resolution.entry.customer);
          if (!res.ok) {
            await say({
              text: `I couldn't resolve ${resolution.entry.displayName}'s state: [${res.reason}] ${res.detail}`,
              thread_ts: threadTs,
            });
            return;
          }
          const { text: fallback, blocks } = formatState(resolution.entry, res.data);
          await say({ text: fallback, blocks: blocks as never, thread_ts: threadTs });
          log.info("query answered", { customer: resolution.entry.customer, ms: Date.now() - started });
          return;
        }
        case "investigate": {
          // Replaced by the InvestigationRunner in M3.
          await say({
            text: ":construction: The investigation loop isn't wired up yet (lands in M3). For now I can answer `what is <customer> running?`",
            thread_ts: threadTs,
          });
          return;
        }
        case "bootstrap":
        case "registry-update": {
          // Replaced by ProposalFlow/BootstrapFlow in M5.
          await say({
            text: ":construction: Registry proposals land in M5. For now, deployments.yaml is edited via PR.",
            thread_ts: threadTs,
          });
          return;
        }
        case "chitchat": {
          await say({
            text:
              "👋 I'm DeployContext — I know what each customer is actually running. Try:\n" +
              "• `@DeployContext what is Acme running?`\n" +
              "• report a customer bug in a thread and tag me to investigate",
            thread_ts: threadTs,
          });
          return;
        }
      }
    } catch (e) {
      log.error("mention handler failed", { error: (e as Error).message });
      await say({
        text: `Something went wrong handling that: ${(e as Error).message}`,
        thread_ts: threadTs,
      }).catch(() => {});
    }
  });

  // Passive listening is scoped to ONE configured channel (deploy-watch, M5).
  // For now we only harvest RTS action tokens from message events.
  app.event("message", async ({ event }) => {
    const ev = event as typeof event & { action_token?: string };
    tokenStore.set(ev.action_token);
  });

  // Buttons arrive in M3 (approval gate) and M5 (confirm cards); ack early
  // clicks so Slack doesn't show an error.
  app.action(/.+/, async ({ ack }) => {
    await ack();
  });

  // ---- Boot ------------------------------------------------------------------
  const reg = await registry.ensureLoaded();
  if (reg.ok) {
    log.info("registry loaded", { customers: registry.list().map((e) => e.customer) });
  } else {
    log.warn("registry not loaded at boot; will retry on demand", { detail: reg.detail });
  }

  // Pre-warm the Unleash client so first query stays ~2s.
  const warm = await unleash.evaluateAll({ provider: "unleash", context: { userId: "__prewarm__" } });
  log.info("unleash prewarm", { ok: warm.ok });

  await app.start();
  log.info("⚡ DeployContext connected (socket mode)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
