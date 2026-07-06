# SETUP — running DeployContext in your own Slack sandbox

This guide is for a collaborator who already has:

- **collaborator access to both GitHub repos** (`DeployContext` and `VikramIyer125/fake-product`), and
- **the shared API keys** (Anthropic key; GitHub PAT if you don't want to use your own).

Slack tokens **cannot** be shared — they are minted per app per workspace — so the bulk of
this doc is standing up your own Slack sandbox + app. Everything else (Unleash, logs,
SQLite) runs locally on your machine and doesn't conflict with anyone else's setup.

The one piece of **shared state** between the two of us is the `fake-product` repo itself:
`deployments.yaml` (the registry's source of truth) and the PRs/branches the fixer opens
live there. See [Shared-state gotchas](#shared-state-gotchas) before confirming any
registry-changing action.

---

## 1. Prerequisites

| Requirement | Notes |
| --- | --- |
| Node 20+ and npm | developed on Node 25; `node --version` to check |
| Docker Desktop | runs Unleash (compose) and the fixer's sandbox tier; must be **running** |
| Slack Developer Program account | free — needed to provision a sandbox workspace |
| Anthropic API key | shared key (`sk-ant-…`) |
| GitHub PAT, classic, `repo` scope | shared PAT, or your own (`gh auth token` works) — your account already has access to both repos |
| git | to clone this repo (you do **not** need to clone fake-product; the app reads it via the GitHub API) |

## 2. Create a Slack sandbox workspace

1. Join the Slack Developer Program (free): https://api.slack.com/developer-program
2. In the developer program dashboard, go to **Sandboxes** → **Provision** a new sandbox.
   Choose the **empty template** — the seed script creates all channels and history itself.
3. Open the sandbox workspace in Slack and make sure you can post as a normal human user.
   (Several flows — RTS action tokens, button clicks — only work from a real user account.)

## 3. Create the Slack app (from the manifest in this repo)

1. https://api.slack.com/apps → **Create New App** → **From a manifest**.
2. Pick your **sandbox workspace** as the target.
3. Paste the contents of `slack-manifest.json` (repo root) → **Create**.
   The manifest carries everything: socket mode, `app_mention` + `message.channels` events,
   interactivity, and the `search:read.public` scope the Real-Time Search API needs.
4. **Install App** → **Install to Workspace** → authorize.
5. Collect two tokens:
   - **Bot token** (`xoxb-…`): *OAuth & Permissions* → Bot User OAuth Token → `SLACK_BOT_TOKEN`
   - **App-level token** (`xapp-…`): *Basic Information* → App-Level Tokens → **Generate**
     with scope `connections:write` → `SLACK_APP_TOKEN`

## 4. Clone, install, configure

```sh
git clone https://github.com/VikramIyer125/DeployContext && cd DeployContext
npm install
cp .env.example .env
```

Fill in `.env` — every line in `.env.example` says where its value comes from:

| Variable | Value for you |
| --- | --- |
| `SLACK_BOT_TOKEN` | your sandbox app's `xoxb-…` (step 3) |
| `SLACK_APP_TOKEN` | your sandbox app's `xapp-…` (step 3) |
| `ANTHROPIC_API_KEY` | the shared key |
| `GITHUB_TOKEN` | the shared PAT (or your own with `repo` scope) |
| `GITHUB_REPO` | `VikramIyer125/fake-product` (leave as-is) |
| `DEPLOY_CHANNEL_ID` | leave blank for now — printed by the seed script in step 6 |
| everything else | defaults are correct for local dev |

Boot fails fast and names any missing variable, so a mistake here is cheap.

## 5. Start Unleash and configure the demo flags

```sh
docker compose up -d       # Unleash OSS + Postgres, tokens pre-provisioned
npm run setup:unleash      # idempotent; creates flags + verifies per-customer evaluation
```

Expect a table ending in `✓ Unleash demo flags configured and verified`
(acme evaluates `new_billing=on, legacy_export=off`; beta the healthy inverse).
The compose file pre-provisions the exact tokens `.env.example` defaults to — no UI clicks.

## 6. Seed the demo world in your Slack workspace

```sh
npm run seed:slack
```

What it does (idempotent — safe to re-run, second run says `posted 0, skipped 31`):

- creates `#deploys`, `#support-acme`, `#eng-general` if missing,
- posts ~31 historical messages (deploy announcements, support chatter) under varied
  personas — this is the "tribal knowledge" layer that bootstrap/RTS mining digs through,
- **prints the channel IDs** at the end.

Then three follow-ups:

1. Put the printed `#deploys` ID into `.env` as `DEPLOY_CHANNEL_ID`.
2. **Join the channels.** Slack does not auto-add humans to bot-created channels — in your
   sidebar: *Add channels → Browse channels* → join all three.
3. **Map your `#support-acme` to acme in the registry.** `deployments.yaml` (in the
   fake-product repo) has acme's `slackChannels: [C0BF6DCE31T]` — that ID is from the
   *original* workspace, not yours. Edit `deployments.yaml` on GitHub and **append** your
   printed `#support-acme` ID to the list (don't replace — the list can hold both
   workspaces' IDs):

   ```yaml
   slackChannels: [C0BF6DCE31T, C_YOUR_ID_HERE]
   ```

   This is what lets the bot infer "message in this channel → it's about acme" without the
   customer being named. Skipping it degrades channel-based resolution but text like
   "Acme says exports fail" still resolves via triage.

## 7. Run

```sh
npm start
```

Healthy startup logs:

```
… INFO registry loaded {"customers":["acme","beta"]}
… INFO unleash prewarm {"ok":true}
… INFO ⚡ DeployContext connected (socket mode)
```

## 8. Smoke test (in order)

1. **Prime RTS**: from your human account, mention the bot once anywhere, e.g.
   `@DeployContext hello`. Slack search (RTS) needs an *action token* minted by a
   human-authored mention/message — a freshly booted bot cannot search until one arrives.
   Bot-authored messages don't mint tokens.
2. **Query fast path** (~2s): `@DeployContext what is Acme running?` → resolved state with
   provenance under every fact. Proves Slack + registry + GitHub + Unleash end to end.
3. **Bootstrap / RTS mining**: `@DeployContext bootstrap the registry` → "mined N messages"
   summary; with the registry already correct it reports both customers up to date.
4. **Investigation** (~30–45s): post in `#support-acme`:
   > Hey team — our nightly billing exports started failing yesterday. The export job errors out partway and the file never lands. Nothing changed on our side as far as I know.

   then reply in-thread: `@DeployContext take care of this` → progress narration → a
   **code-issue** diagnosis card citing the `new_billing=on + legacy_export=off` delta on
   v2.3.1, with an **Attempt fix →** button.
5. **Fix** (2–4 min): click **Attempt fix →** → sandboxed clone at the pinned tag →
   failing test → fix → verified PR link in-thread. Needs Docker running; if unavailable,
   set `WORKSPACE_TIER=tempdir` in `.env` (same flow, weaker isolation).

Full checklist, verification harnesses, and demo runbook: see `README.md`.

## Shared-state gotchas

Both of our app instances point at the **same** `fake-product` repo, so:

- **`deployments.yaml` is shared truth.** If either of us confirms a deploy-watch bump or
  a bootstrap proposal, the registry changes *for both*. Coordinate before confirming
  registry writes, and after demoing a version bump, **restore acme's pin** (the seeded
  bug lives at tag `acme-prod-v2.3.1`): mention
  `@DeployContext acme moved back to v2.3.1 (tag acme-prod-v2.3.1)` and confirm.
- **Fixer PRs accumulate in the shared repo.** Close/merge your test PRs and delete fix
  branches when done.
- **Everything else is per-machine** — Unleash (your Docker), log fixtures, SQLite
  (`data/`), and your Slack workspace — no coordination needed there.

## Troubleshooting

The README's troubleshooting section covers the failures actually hit while building.
The two most likely for a fresh workspace:

- **Bootstrap mines 0 messages** → you skipped smoke-test step 1; mention the bot from a
  human account first so an RTS action token exists.
- **Seeded channels aren't in your sidebar** → Slack doesn't auto-join you to bot-created
  channels; *Add channels → Browse channels*.
