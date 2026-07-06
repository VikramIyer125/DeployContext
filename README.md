# DeployContext

**A Slack agent that knows what each of your customers is actually running — and debugs their bugs in *their* reality instead of `main`'s.**

Companies with enterprise customers never have all customers on the same software. Each customer's real runtime state is a tuple: **(version pin) × (feature-flag set) × (config bundle)** — assembled across git, a flag provider, config files, and tribal knowledge in Slack. No record of this tuple exists anywhere; engineers reconstruct it by hand every time a customer reports a bug, and bugs frequently only reproduce under one customer's specific combination.

DeployContext bootstraps a **deployment registry** (customer → tuple) by mining Slack history with the Real-Time Search API, keeps it fresh by watching your deploy-announcements channel, answers "what is customer X running?" instantly **with provenance for every claim**, and investigates customer bug reports by diffing the affected customer's resolved state against a healthy customer's to isolate the responsible delta. On a code-issue verdict and **explicit human approval**, it launches a sandboxed code-fixing agent (no network, no credentials) that reproduces the bug with a failing test, fixes it, and opens a PR **against the customer's pinned ref** with the full diagnosis in the PR body.

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
                            CodeFixer (Agent SDK, sandboxed, network disconnected)
                               │ clone at customer ref → failing test → fix → verify
                               ▼ wrapper (outside sandbox) pushes branch + opens PR
                            GitHub PR ──► link posted back in thread

Registry truth: manifest YAML in git (written only via commit/PR)
Derived: in-memory cache (rebuildable) · SQLite: proposals + investigations (disposable)
```

- **Layer 0 — domain** (`src/domain`): registry entry / resolved-state / diagnosis types. Provenance is per-fact via `Attested<T>`.
- **Layer 1 — connectors** (`src/connectors`): bespoke interfaces per system (GitHub, Unleash, logs, Slack RTS search). Errors are data (`ConnectorResult`), results are size-curated summaries, and in-memory fakes make the whole core testable offline.
- **Layer 2 — orchestrator** (`src/app.ts`, `src/triage.ts`, `src/resolve`, `src/investigate`, `src/bootstrap`, `src/deploywatch`): cheap Haiku triage in front, deterministic `StateResolver` + pure `diff()`, the Opus investigation loop with a curated tool menu and hard ceilings (fail-closed), and the proposal flow that is the only write path to registry truth.
- **Layer 3 — CodeFixer** (`src/fixer`): the Claude Agent SDK drives tools whose only execution path is inside a network-disconnected Docker container; the GitHub token never enters the sandbox; the `VerificationReport` is computed by wrapper code, never trusted from the model.

## Prerequisites

- Node 20+ (developed on Node 25) and npm
- Docker Desktop (runs Unleash; also the fixer's sandbox tier)
- A Slack **developer sandbox** (Slack Developer Program → Sandboxes → Provision, empty template)
- An Anthropic API key
- A GitHub account (ideally a bot account) with a classic PAT, `repo` scope
- A product repo for the registry to point at — the demo world uses the seeded
  `fake-product` repo (tag `acme-prod-v2.3.1` carries a reproducible bug; `main` has the guard)

## Setup

1. **Clone and install**
   ```sh
   git clone https://github.com/VikramIyer125/DeployContext && cd DeployContext
   npm install
   ```
2. **Configure secrets**
   ```sh
   cp .env.example .env
   # fill in each key — every line in .env.example says where to get its value
   ```
3. **Start Unleash and configure the demo flags**
   ```sh
   docker compose up -d
   npm run setup:unleash   # idempotent; creates flags + verifies per-customer evaluation
   ```
   Expect a table ending in `✓ Unleash demo flags configured and verified` (acme evaluates `new_billing=on, legacy_export=off`; beta the healthy inverse).
4. **Create the Slack app**: https://api.slack.com/apps → *Create New App* → *From a manifest* → pick your sandbox workspace → paste `slack-manifest.json` → Create → *Install to Workspace*. Copy the **Bot User OAuth Token** into `SLACK_BOT_TOKEN`, and generate an app-level token (*Basic Information → App-Level Tokens*, scope `connections:write`) into `SLACK_APP_TOKEN`.
5. **Seed the demo world in Slack**
   ```sh
   npm run seed:slack      # idempotent: creates #deploys/#support-acme/#eng-general, posts ~31 messages
   ```
   It prints the channel IDs — put `#deploys`' ID in `.env` as `DEPLOY_CHANNEL_ID`, and (if you run your own product repo) list `#support-acme`'s ID under acme's `slackChannels` in `deployments.yaml`. Note: Slack does not auto-add humans to bot-created channels — join them via *Add channels → Browse channels* (or have the bot invite you).

## Running

```sh
npm start
```

Healthy startup logs (observed):

```
… INFO registry loaded {"customers":["acme","beta"]}
… INFO unleash prewarm {"ok":true}
… INFO ⚡ DeployContext connected (socket mode)
```

Boot fails fast, naming every missing env var with a pointer to where to get it.

## Verify it works (smoke checklist, in order — all timings observed)

1. **Boot**: no missing-env errors; the three log lines above appear.
2. **Query fast path**: `@DeployContext what is Acme running?` in any bot channel → resolved state (version pin, live flags, config) with a provenance line under every fact, in **~2s**. Proves Slack + registry + GitHub + Unleash end to end.
3. **Bootstrap / RTS mining**: `@DeployContext bootstrap the registry` (from a **human** account — bot-authored mentions don't mint RTS action tokens) → "mined N messages" summary; with the registry already correct it reports both customers up to date; against an empty manifest it posts per-customer confirm cards. Proves the Real-Time Search API path.
4. **Investigation**: post the demo bug report in `#support-acme`:
   > Hey team — our nightly billing exports started failing yesterday. The export job errors out partway and the file never lands. Nothing changed on our side as far as I know.
   
   then reply in-thread: `@DeployContext take care of this` → progress narration lines, then a **code-issue** diagnosis card citing the `new_billing=on + legacy_export=off` delta on v2.3.1, with an **Attempt fix →** button (~30–45s).
5. **Fix**: click **Attempt fix →** → sandbox init (clone at the pinned tag + `npm install`, then network disconnected and verified) → reproduce-first fixer → wrapper-verified PR link posted in-thread. Observed duration **2–4 min** (docker tier); budget 5–10.
6. **Deploy-watch**: post `shipped v2.5 to Acme 🚀 tag v2.5.0` in `#deploys` (human account) → registry-bump confirm card in-thread; **Confirm** commits the manifest change directly and links it. (Restore the demo pin afterwards — see the runbook note below.)

## Verification harnesses (how the milestones were proven)

| Script | What it proves | Result on the seeded world |
| --- | --- | --- |
| `npm run verify:bug` | seeded bug fails at the tag, guarded on main | ✓ |
| `npx tsx scripts/resolve.ts acme --diff beta` | live resolve + pure diff | flag/config/version deltas |
| `npx tsx scripts/run-investigation.ts --trials 10` | real Opus investigation loop | 10/10 correct diagnoses |
| `npx tsx scripts/run-fix.ts --trials 10 --tier docker` | real sandboxed fixer → verified PR | 10/10 PRs, 1.6–3.2 min |
| `npx tsx scripts/run-bootstrap.ts` | synthesis vs seeded history | acme+beta proposed correctly |
| `npx tsx scripts/run-deploywatch.ts` | classifier + real manifest write path | full cycle incl. restore |
| `npx tsx scripts/run-storyboard.ts --trials 10` | the FULL chained flow (definition of done) | see repo history |
| `npm test` | offline core against fakes | 121 tests |

## Demo runbook notes

- **Filming the bootstrap beat**: to see confirm cards on camera, point the app at an empty manifest first (commit `customers: {}` to `deployments.yaml`, run bootstrap, confirm the two cards — new customers arrive as reviewable PRs by design — then merge or reset).
- **After confirming a deploy-watch bump on camera**, restore Acme's pin (the seeded bug lives at the tag): mention `@DeployContext acme moved back to v2.3.1 (tag acme-prod-v2.3.1)` and confirm, or run `npx tsx scripts/run-deploywatch.ts` which ends restored.
- The live bug report and button clicks must come from real user accounts (per the hackathon rules and because Slack bots can't click buttons).

## Troubleshooting (from failures actually hit while building)

- **Boot exits naming missing env vars** → fill the named keys in `.env`; each has a source pointer in `.env.example`.
- **`unleash prewarm {"ok":false}`** → Unleash isn't up or tokens don't match: `docker compose up -d`, then `npm run setup:unleash`. Compose pre-provisions the exact tokens `.env.example` defaults to.
- **Fix attempt fails immediately with "Docker daemon not reachable"** → start Docker Desktop, or set `WORKSPACE_TIER=tempdir` (Tier-1 fallback; same flow, weaker isolation).
- **Bootstrap says "mined 0/2 messages"** → RTS action tokens are only minted by **human-authored** mentions; mention the bot from a real account first. Multi-word keyword queries also return almost nothing on RTS — mining queries are code-owned in `src/bootstrap/flow.ts` (semantic questions + single keywords) if you tune them.
- **Seeded channels aren't in your sidebar** → Slack doesn't auto-join humans to bot-created channels; *Add channels → Browse channels*, or have the bot `conversations.invite` you.
- **Seed script re-posts messages containing emoji** → fixed: Slack rewrites Unicode emoji to `:shortcode:` in stored text; the seed script normalizes both sides before comparing. Re-runs should say `posted 0, skipped 31`.
- **GitHub 404s on a private product repo** → the PAT needs `repo` scope and access to that repo; for judges, the demo PRs need the repo visible.
- **Judges can't log into the sandbox** → invite `slackhack@salesforce.com` and `testing@devpost.com` from the sandbox admin page and test the invite flow before submitting; check any domain allowlist admits those domains.

## Repo map

| Path | What it is |
| --- | --- |
| `src/app.ts` | Slack socket-mode wiring, router, action handlers (approval gate lives here) |
| `src/triage.ts` | Haiku mode classifier + §5 customer-resolution rules |
| `src/domain/` | Layer 0 types (registry, provenance, diagnosis, verification) |
| `src/registry/` | Manifest parse/serialize, cache, ProposalStore, RegistryManager (the write path) |
| `src/resolve/` | StateResolver + pure `diff()` |
| `src/connectors/` | GitHub / Unleash / logs / Slack-RTS connectors + in-memory fakes |
| `src/investigate/` | ToolRegistry, InvestigationRunner, reporter, SQLite store |
| `src/bootstrap/` | BootstrapFlow (RTS mining → synthesis → proposals) |
| `src/deploywatch/` | #deploys listener (classifier → bump proposals) |
| `src/fixer/` | WorkspaceManager (docker/tempdir), fixer prompt, wrapper verification, PR body |
| `src/slack/` | Block Kit formatting (state, diagnosis card, proposal cards) |
| `scripts/` | Demo-world setup + the verification harnesses above |
| `fixtures/` | Log fixtures + Slack seed content |
| `docker/` | Fixer sandbox image (optional slim build) |
| `docker-compose.yml` | Unleash OSS + Postgres with pre-provisioned tokens |
| `test/` | Offline unit/integration tests against fakes (121 tests) |
| `slack-manifest.json` | Slack app manifest (socket mode, RTS scope, events, interactivity) |
