/**
 * Seeds the Slack sandbox with the demo world's historical message layer.
 * Idempotent: channels are created only if missing, and a message is only
 * posted if its exact text is not already present in the channel.
 *
 * Message content lives in fixtures/slack-seed.json so wording can be
 * iterated without code changes. Historical messages are posted with
 * username/icon overrides (requires the chat:write.customize bot scope), so
 * they appear from varied team personas.
 *
 * Usage:
 *   SLACK_BOT_TOKEN=xoxb-… npx tsx scripts/seed-slack.ts
 *   npx tsx scripts/seed-slack.ts --dry-run   # print actions, no API calls
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebClient } from "@slack/web-api";

interface SeedFile {
  channels: Array<{ name: string; topic: string }>;
  personas: Record<string, { username: string; icon_emoji: string }>;
  messages: Array<{ channel: string; persona: string; text: string }>;
}

const DRY_RUN = process.argv.includes("--dry-run") || process.env.SEED_DRY_RUN === "1";

const seedPath = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "slack-seed.json");
const seed = JSON.parse(readFileSync(seedPath, "utf8")) as SeedFile;

function validateSeed(): void {
  const channelNames = new Set(seed.channels.map((c) => c.name));
  for (const [i, msg] of seed.messages.entries()) {
    if (!channelNames.has(msg.channel)) {
      throw new Error(`message[${i}] references unknown channel "${msg.channel}"`);
    }
    if (!seed.personas[msg.persona]) {
      throw new Error(`message[${i}] references unknown persona "${msg.persona}"`);
    }
    if (!msg.text.trim()) throw new Error(`message[${i}] has empty text`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  validateSeed();
  console.log(
    `seed file ok: ${seed.channels.length} channels, ${seed.messages.length} messages, ${Object.keys(seed.personas).length} personas`,
  );

  if (DRY_RUN) {
    for (const ch of seed.channels) console.log(`[dry-run] ensure channel #${ch.name} (topic: ${ch.topic})`);
    for (const m of seed.messages) {
      console.log(`[dry-run] post to #${m.channel} as ${seed.personas[m.persona].username}: ${m.text.slice(0, 80)}…`);
    }
    console.log("[dry-run] no API calls made");
    return;
  }

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error("SLACK_BOT_TOKEN is required (or pass --dry-run). Get it from your Slack app's OAuth & Permissions page after installing to the sandbox.");
    process.exit(1);
  }
  const slack = new WebClient(token);

  // ---- Ensure channels exist and the bot is a member ----------------------
  const channelIds = new Map<string, string>();
  const existing = new Map<string, string>();
  for await (const page of slack.paginate("conversations.list", {
    types: "public_channel",
    exclude_archived: true,
    limit: 200,
  }) as AsyncIterable<{ channels?: Array<{ id: string; name: string }> }>) {
    for (const ch of page.channels ?? []) existing.set(ch.name, ch.id);
  }

  for (const ch of seed.channels) {
    let id = existing.get(ch.name);
    if (id) {
      console.log(`channel #${ch.name} exists (${id})`);
    } else {
      const created = await slack.conversations.create({ name: ch.name });
      id = created.channel!.id!;
      console.log(`created channel #${ch.name} (${id})`);
      await slack.conversations.setTopic({ channel: id, topic: ch.topic });
    }
    channelIds.set(ch.name, id);
    await slack.conversations.join({ channel: id }).catch(() => {
      /* already a member */
    });
  }

  // ---- Collect texts already present (idempotency) ------------------------
  const alreadyPosted = new Map<string, Set<string>>();
  for (const [name, id] of channelIds) {
    const texts = new Set<string>();
    for await (const page of slack.paginate("conversations.history", {
      channel: id,
      limit: 200,
    }) as AsyncIterable<{ messages?: Array<{ text?: string }> }>) {
      for (const msg of page.messages ?? []) if (msg.text) texts.add(msg.text);
    }
    alreadyPosted.set(name, texts);
  }

  // ---- Post missing messages in fixture order ------------------------------
  let posted = 0;
  let skipped = 0;
  for (const msg of seed.messages) {
    if (alreadyPosted.get(msg.channel)!.has(msg.text)) {
      skipped++;
      continue;
    }
    const persona = seed.personas[msg.persona];
    await slack.chat.postMessage({
      channel: channelIds.get(msg.channel)!,
      text: msg.text,
      username: persona.username,
      icon_emoji: persona.icon_emoji,
    });
    posted++;
    await sleep(700); // stay under chat.postMessage rate limits, preserve order
  }

  console.log(`\nposted ${posted}, skipped ${skipped} (already present)`);
  console.log("\nchannel IDs (for .env DEPLOY_CHANNEL_ID and deployments.yaml slackChannels):");
  for (const [name, id] of channelIds) console.log(`  #${name} → ${id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
