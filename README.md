# DeployContext

**A Slack agent that knows what each of your customers is actually running — and debugs their bugs in *their* reality instead of `main`'s.**

Companies with enterprise customers never have all customers on the same software. Each customer's real runtime state is a tuple: **(version pin) × (feature-flag set) × (config bundle)** — assembled across git, a flag provider, config files, and tribal knowledge in Slack. No record of this tuple exists anywhere; engineers reconstruct it by hand every time a customer reports a bug, and bugs frequently only reproduce under one customer's specific combination.

DeployContext bootstraps a **deployment registry** (customer → tuple) by mining Slack history, keeps it fresh by watching your deploy-announcements channel, answers "what is customer X running?" instantly **with provenance for every claim**, and investigates customer bug reports by diffing the affected customer's resolved state against a healthy customer's to isolate the responsible delta. On a code-issue verdict and **explicit human approval**, it launches a sandboxed code-fixing agent that reproduces the bug with a failing test, fixes it, and opens a PR **against the customer's pinned ref** with the full diagnosis in the PR body.

The registry thesis: store *descriptors* (pointers to where truth lives — a git ref, an Unleash context, a config path), never resolved values. Resolve live at query time; attach provenance to every fact.

## Architecture at a glance

```
Slack (Socket Mode)
   │  mentions / #deploys messages / button actions
   ▼
App (router) ──► Haiku triage {mode, customer}
   │
   ├── mode=query ────────► StateResolver ──► formatted reply (fast path, no agent loop)
   ├── mode=registry-op ──► ProposalFlow ──► confirm card ──► RegistryManager ──► git commit/PR
   ├── mode=bootstrap ────► BootstrapFlow (RTS mining ──► batch of Proposals ──► confirm cards)
   └── mode=investigate ──► InvestigationRunner (Opus loop)
                               │ tools: resolve_customer_state / diff_customer_states /
                               │        find_deploy_announcements / find_prior_reports /
                               │        search_slack_freeform / query_logs /
                               │        read_code_at_customer_ref / submit_diagnosis
                               ▼
                            Diagnosis {config-issue | code-issue | inconclusive}
                               │ posted in-thread with evidence citations
                               ▼ human clicks "Attempt fix" (MANDATORY GATE)
                            CodeFixer (Agent SDK in Docker, --network=none)
                               │ clone at customer ref → failing test → fix → verify
                               ▼ wrapper (outside sandbox) pushes branch + opens PR
                            GitHub PR ──► link posted back in thread

Registry truth: manifest YAML in git (written only via commit/PR)
Derived: in-memory cache (rebuildable) · SQLite: proposals + investigations (disposable)
```

- **Layer 0 — domain** (`src/domain`): the registry entry / resolved-state / diagnosis types. Provenance is per-fact via `Attested<T>`.
- **Layer 1 — connectors** (`src/connectors`): bespoke interfaces per system (GitHub, Unleash, logs, Slack search). Errors are data (`ConnectorResult`), results are size-curated summaries, and in-memory fakes make the whole core testable offline.
- **Layer 2 — orchestrator** (`src/app.ts`, `src/triage.ts`, `src/resolve`, `src/investigate`): cheap Haiku triage in front, deterministic `StateResolver` + pure `diff()`, and the Opus investigation loop with a curated tool menu.
- **Layer 3 — CodeFixer** (`src/fixer`): the Claude Agent SDK inside a network-less sandbox; the GitHub token never enters it; verification is computed by wrapper code.

## Prerequisites

- Node 20+ (developed on Node 25) and npm
- Docker Desktop (Unleash stack; also the fixer's sandbox tier)
- A Slack **developer sandbox** (Slack Developer Program → Sandboxes)
- An Anthropic API key
- A GitHub account/bot account with a PAT (`repo` scope) and a product repo
  (the demo uses the seeded `fake-product` repo)

## Setup

1. **Clone and install**
   ```sh
   git clone <this repo> && cd DeployContext
   npm install
   ```
2. **Configure secrets**
   ```sh
   cp .env.example .env
   # fill in each key — every line in .env.example says where to get its value
   ```
3. **Start Unleash and configure demo flags**
   ```sh
   docker compose up -d
   npm run setup:unleash   # idempotent; creates flags + verifies per-customer evaluation
   ```
4. **Create the Slack app**: https://api.slack.com/apps → *Create New App* → *From a manifest* → pick your sandbox workspace → paste `slack-manifest.json`. Then *Install to Workspace*. Copy the bot token (`SLACK_BOT_TOKEN`) and generate an app-level token with `connections:write` (`SLACK_APP_TOKEN`) into `.env`.
5. **Seed the demo world in Slack**
   ```sh
   npm run seed:slack      # idempotent; prints channel IDs — put #deploys' ID in .env as DEPLOY_CHANNEL_ID
   ```

## Running

```sh
npm start
```

Healthy startup logs look like:

```
… INFO registry loaded {"customers":["acme","beta"]}
… INFO unleash prewarm {"ok":true}
… INFO ⚡ DeployContext connected (socket mode)
```

## Verify it works (smoke checklist)

> Sections below are finalized in M6 from observed behavior; current status of
> each build milestone is tracked in the repo history.

1. App boots with no missing-env errors and logs "connected" for socket mode.
2. `@DeployContext what is Acme running?` → resolved state with provenance in a few seconds (proves Slack + registry + GitHub + Unleash all work).
3. `@DeployContext bootstrap the registry` in a seeded channel → proposal cards appear (proves RTS mining). *(lands in M5)*
4. Post the demo bug report and tag the agent → diagnosis card with an "Attempt fix" button (proves the investigation loop). *(lands in M3)*
5. Click "Attempt fix" → PR link posted in-thread (proves the fixer sandbox + GitHub write path). *(lands in M4)*

## Troubleshooting

*(Finalized in M6 from real observed failures.)*

- **Boot fails naming missing env vars** — fill the named keys in `.env`; each has a pointer in `.env.example`.
- **`unleash prewarm {"ok":false}`** — Unleash isn't up or tokens don't match: `docker compose up -d`, then `npm run setup:unleash`.

## Repo map

| Path | What it is |
| --- | --- |
| `src/app.ts` | Slack socket-mode wiring, router, action handlers |
| `src/triage.ts` | Haiku mode classifier + customer resolution rules |
| `src/domain/` | Layer 0 types (registry, provenance, diagnosis) |
| `src/registry/` | Manifest parse/validate/serialize + in-memory cache |
| `src/resolve/` | StateResolver + pure diff() |
| `src/connectors/` | GitHub / Unleash / logs / Slack-search connectors + fakes |
| `src/slack/` | Block-kit formatting |
| `scripts/` | Demo-world setup: seed Slack, setup Unleash, verify seeded bug, resolve CLI |
| `fixtures/` | Log fixtures + Slack seed content |
| `docker-compose.yml` | Unleash OSS + Postgres |
| `fake-product/` | (gitignored; own repo) the seeded demo product |
| `test/` | Offline unit tests against fakes |
