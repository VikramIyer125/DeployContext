/**
 * Dev tool: probe live RTS (assistant.search.context) with candidate mining
 * queries, using an action token captured by the running app
 * (DEBUG_SAVE_ACTION_TOKEN=1 → data/action-token.txt).
 *
 * Usage: npx tsx scripts/rts-probe.ts ["query 1" "query 2" …]
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { WebClient } from "@slack/web-api";

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  console.error("SLACK_BOT_TOKEN required");
  process.exit(1);
}
let actionToken: string;
try {
  actionToken = readFileSync("data/action-token.txt", "utf8").trim();
} catch {
  console.error("no data/action-token.txt — run the app with DEBUG_SAVE_ACTION_TOKEN=1 and mention it once");
  process.exit(1);
}

const queries =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : [
        "What was shipped or deployed to each customer?",
        "Which version or tag is each customer running?",
        "shipped",
        "deployed",
        "rolled out",
        "pinned",
        "upgrade window",
      ];

const web = new WebClient(token);

for (const query of queries) {
  try {
    const res = (await web.apiCall("assistant.search.context", {
      query,
      action_token: actionToken,
      channel_types: ["public_channel"],
      content_types: ["messages"],
      limit: 20,
    })) as { results?: { messages?: Array<{ content?: string; channel_name?: string }> } };
    const messages = res.results?.messages ?? [];
    console.log(`\n■ "${query}" → ${messages.length} hits`);
    for (const m of messages.slice(0, 5)) {
      console.log(`  [#${m.channel_name}] ${(m.content ?? "").slice(0, 110).replace(/\n/g, " ")}`);
    }
  } catch (e) {
    console.log(`\n■ "${query}" → ERROR: ${(e as Error).message}`);
  }
}
