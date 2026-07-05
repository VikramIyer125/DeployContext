/**
 * Configuration & secrets, per BRIEF §8. Validates on boot and fails fast
 * with a clear message naming every missing variable — no partial startup
 * with cryptic downstream errors.
 */

export interface AppConfig {
  slackBotToken: string;
  slackAppToken: string;
  anthropicApiKey: string;
  githubToken: string;
  githubRepo: string;
  unleashUrl: string;
  unleashApiToken: string;
  unleashAdminToken: string | undefined;
  deployChannelId: string;
  manifestPath: string;
  logFixturesPath: string;
  sqlitePath: string;
  workspaceTier: "docker" | "tempdir";
}

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

const REQUIRED: Array<{ key: string; hint: string }> = [
  { key: "SLACK_BOT_TOKEN", hint: "xoxb-… — Slack app → OAuth & Permissions after installing to the sandbox" },
  { key: "SLACK_APP_TOKEN", hint: "xapp-… — Slack app → Basic Information → App-Level Tokens (connections:write)" },
  { key: "ANTHROPIC_API_KEY", hint: "sk-ant-… — https://console.anthropic.com/settings/keys" },
  { key: "GITHUB_TOKEN", hint: "bot-account PAT with repo scope (dev: `gh auth token`)" },
  { key: "GITHUB_REPO", hint: "owner/name of the product repo, e.g. VikramIyer125/fake-product" },
  { key: "DEPLOY_CHANNEL_ID", hint: "channel ID of #deploys — printed by scripts/seed-slack.ts" },
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const missing = REQUIRED.filter(({ key }) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new EnvError(
      "missing required environment variables:\n" +
        missing.map(({ key, hint }) => `  ${key}  (${hint})`).join("\n") +
        "\nCopy .env.example to .env and fill in the blanks.",
    );
  }

  const workspaceTier = env.WORKSPACE_TIER ?? "docker";
  if (workspaceTier !== "docker" && workspaceTier !== "tempdir") {
    throw new EnvError(`WORKSPACE_TIER must be "docker" or "tempdir", got "${workspaceTier}"`);
  }

  return {
    slackBotToken: env.SLACK_BOT_TOKEN!,
    slackAppToken: env.SLACK_APP_TOKEN!,
    anthropicApiKey: env.ANTHROPIC_API_KEY!,
    githubToken: env.GITHUB_TOKEN!,
    githubRepo: env.GITHUB_REPO!,
    unleashUrl: env.UNLEASH_URL ?? "http://localhost:4242",
    unleashApiToken:
      env.UNLEASH_API_TOKEN ?? "default:production.deploycontext-insecure-client-token",
    unleashAdminToken: env.UNLEASH_ADMIN_TOKEN ?? "*:*.deploycontext-insecure-admin-token",
    deployChannelId: env.DEPLOY_CHANNEL_ID!,
    manifestPath: env.MANIFEST_PATH ?? "deployments.yaml",
    logFixturesPath: env.LOG_FIXTURES_PATH ?? "fixtures/logs.json",
    sqlitePath: env.SQLITE_PATH ?? "data/deploycontext.db",
    workspaceTier,
  };
}
