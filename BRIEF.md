# BRIEF.md — DeployContext

A Slack agent that knows what each of your customers is actually running — and debugs their bugs in *their* reality instead of `main`'s.

This document is the complete implementation spec. It is written for a coding agent (e.g. Claude Code) to build from directly. Read it fully before writing code. Where the doc says MUST, it is an invariant, not a suggestion.

---

## 1. Problem & product summary

Companies with enterprise customers never have all customers on the same software. Each customer's real runtime state is a tuple: **(version pin) × (feature-flag set) × (config bundle)**, assembled across git, a flag provider, config files, and tribal knowledge in Slack. No record of this tuple exists anywhere; engineers reconstruct it by hand every time a customer reports a bug, and bugs frequently only reproduce under one customer's specific combination.

DeployContext is an **open-source Slack agent** that:

1. **Bootstraps a deployment registry** (customer → tuple) by mining Slack history and connected systems, proposing entries for human confirmation.
2. **Maintains** the registry passively by watching a deploy-announcements channel and proposing updates.
3. **Answers** "what is customer X running?" instantly, with provenance for every claim.
4. **Investigates** customer bug reports: resolves the reporting customer's state, gathers evidence (logs, Slack history, code), **diffs the affected customer against a healthy customer** to isolate the responsible delta, and issues a verdict: config issue / code issue / inconclusive.
5. On a code verdict and **explicit human approval**, launches a sandboxed code-fixing agent that reproduces the bug with a failing test, fixes it, and opens a PR **against the customer's pinned ref** with the full diagnosis in the PR body.

### Hackathon context (Slack Agent Builder Challenge)
- Track: **New Slack Agent**. Judged on: technological implementation, design, potential impact, quality of idea.
- Must use ≥1 of: Slack AI capabilities, MCP server integration, **Real-Time Search (RTS) API**. RTS is load-bearing in this design (bootstrap evidence mining + investigation-time history search). Built on the Slack agent platform (`slack create agent` CLI scaffold).
- Deliverables: ~3-min demo video, architecture diagram, sandbox URL (shared with `slackhack@salesforce.com` and `testing@devpost.com`), text description.

### Demo storyboard (acceptance criteria — the build is done when this films cleanly)
1. **(0:00–0:25)** Problem framing (no product on screen).
2. **(0:25–0:50)** Bootstrap: agent mines channel history via RTS, posts proposed registry ("Here's what I think each customer runs — confirm?"), one-click confirm.
3. **(0:50–2:20)** Main flow: support message "Acme says exports are failing" → human tags agent "take care of this" → agent resolves Acme's tuple → searches Slack/logs for evidence → diffs Acme vs. healthy customer Beta → posts diagnosis in-thread ("only reproduces with flags `new_billing=on` + `legacy_export=off` on v2.3.1") → human clicks "Attempt fix →" → cut to GitHub: PR open against `acme-prod-v2.3.1` with diagnosis, repro test, verification report → human approves.
4. **(2:20–3:00)** Thesis + architecture diagram + tech checklist.
5. Bonus beat if time: someone posts "shipped v2.5 to Acme 🚀" in #deploys; agent proposes registry bump.

Judges will also poke the live sandbox off-script. "What is Beta running?" MUST answer well at any time.

---

## 2. Stack & high-level architecture

- **Language:** TypeScript (Node). Single Node process. Slack connection via **Socket Mode** (no public URL required; process hosted on a small VPS during judging).
- **LLM brain, two-tier:**
  - **Orchestrator:** hand-built tool-use loop on the raw **Anthropic Messages API**.
  - **CodeFixer:** the **Claude Agent SDK** (TypeScript), invoked as a subsystem inside a sandbox.
- **Models:** `claude-haiku-4-5` for triage/classification; **`claude-opus-4-8`** for the investigation loop (with extended thinking) and for the CodeFixer; bootstrap evidence-synthesis may use `claude-sonnet-4-6` or Opus (implementer's choice — one-shot structured extraction).
- **External systems (v1):** GitHub (REST, bot account + PAT), **Unleash** (flag provider), a **seeded log source** (JSON fixtures behind an interface), **Slack RTS** for message search. Container registry is explicitly OUT of v1 (roadmap).

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

---

## 3. Layer 0 — Domain model

Core principle: **the registry stores descriptors (pointers to where truth lives), never resolved values.** Live values (e.g. flag states) are resolved at query time. Second principle: **provenance is first-class and per-fact**, via `Attested<T>`.

```typescript
type CustomerId = string; // "acme"

interface RegistryEntry {
  customer: CustomerId;
  displayName: string;
  code: CodeRef;
  versionPin: Attested<string>;      // "v2.3.1"
  flagContext: FlagContextRef;       // how to ask Unleash "as Acme"
  config: ConfigRef | null;
  notes: string[];                   // unstructured tribal knowledge; injected into
                                     // investigation context verbatim; never parsed
  slackChannels?: string[];          // Slack channel IDs associated with this customer
                                     // (e.g. shared/Connect channel "#support-acme");
                                     // used by triage for channel→customer resolution
}

interface CodeRef { repo: string; refType: "branch" | "tag"; ref: Attested<string>; }
interface FlagContextRef { provider: "unleash"; context: Record<string, string>; }
interface ConfigRef { repo: string; path: string; }   // e.g. "customers/acme/values.yaml"

interface Attested<T> { value: T; provenance: Provenance[]; }
interface Provenance {
  source: "slack" | "github" | "unleash" | "logs" | "human";
  evidenceUrl: string;               // Slack permalink / commit URL / etc.
  observedAt: string;                // ISO date
  confidence: "confirmed" | "inferred-high" | "inferred-low";
}

interface ResolvedState {
  customer: CustomerId;
  resolvedAt: string;
  version: Attested<string>;
  flags: Attested<Record<string, boolean | string>>;   // queried live from Unleash
  config: Attested<Record<string, unknown>>;           // parsed from repo at ref
}

interface StateDelta {
  a: CustomerId; b: CustomerId;
  versionDelta: { a: string; b: string } | null;
  flagDeltas: Array<{ flag: string; a: unknown; b: unknown }>;
  configDeltas: Array<{ path: string; a: unknown; b: unknown }>;
}
// diff(a: ResolvedState, b: ResolvedState): StateDelta is a PURE FUNCTION.
// No LLM involvement. Unit-tested in isolation.

interface Investigation {
  id: string;
  trigger: { channel: string; threadTs: string; permalink: string; text: string };
  customer: CustomerId;
  evidence: Evidence[];              // accumulated STRUCTURALLY by tool handlers
  diagnosis?: Diagnosis;
  status: "running" | "diagnosed" | "fixing" | "done" | "escalated";
}

interface Evidence {
  kind: "slack-message" | "log-line" | "flag-state" | "code-snippet" | "state-delta";
  summary: string;
  source: Provenance;
}

interface Diagnosis {
  verdict: "config-issue" | "code-issue" | "inconclusive";
  culprit: string;
  reasoning: string;
  recommendedAction:
    | { type: "flag-change"; changes: Array<{ flag: string; to: unknown }> }
    | { type: "code-fix"; brief: CodeFixBrief }
    | { type: "escalate"; toHuman: string };
}

interface CodeFixBrief {
  repo: string;
  ref: string;                       // the customer's pinned ref — never main
  bugSummary: string;
  reproductionConditions: {
    flags: Record<string, unknown>;
    configExcerpt?: string;
    versionNote: string;
  };
  evidence: Evidence[];
  constraints: string[];             // e.g. "minimal diff", "no new dependencies"
}

type FixOutcome =
  | { status: "pr-opened"; prUrl: string; summary: string; verification: VerificationReport }
  | { status: "no-repro"; detail: string }
  | { status: "fix-unverified"; branchUrl: string; detail: string }
  | { status: "failed"; reason: string; transcript: string };

interface VerificationReport {      // computed by WRAPPER CODE, never trusted from the model
  reproTestAdded: boolean;
  reproTestFailsOnOriginal: boolean;
  reproTestPassesOnFixed: boolean;
  fullSuitePassed: boolean;
  linesChanged: number;
}
```

### Registry manifest file (source of truth)

Lives in the team's repo (for the demo: in the fake product repo) at `deployments.yaml`. Human-readable, agent-maintained, changed only via git commit/PR.

```yaml
# deployments.yaml — maintained by DeployContext. Edit via PR.
customers:
  acme:
    displayName: Acme Corp
    code: { repo: yourco/fake-product, refType: tag, ref: acme-prod-v2.3.1 }
    versionPin: v2.3.1
    flagContext: { provider: unleash, context: { userId: acme, environment: production } }
    config: { repo: yourco/fake-product, path: customers/acme/values.yaml }
    slackChannels: [C0123ACME]        # e.g. #support-acme shared channel
    notes:
      - "Runs pinned; upgrade window is quarterly, next in Sept."
    provenance:
      versionPin: { source: human, evidenceUrl: <slack-permalink>, observedAt: 2026-06-12, confidence: confirmed }
      ref:        { source: slack, evidenceUrl: <slack-permalink>, observedAt: 2026-05-03, confidence: inferred-high }
  beta:
    displayName: Beta Industries
    code: { repo: yourco/fake-product, refType: branch, ref: main }
    versionPin: v2.5.0
    flagContext: { provider: unleash, context: { userId: beta, environment: production } }
    config: { repo: yourco/fake-product, path: customers/beta/values.yaml }
    notes: []
```

**Storage tiers (invariant):** git manifest = confirmed truth (write path: `RegistryManager` → commit or PR only). In-memory parsed cache = derived, rebuilt on poll/webhook, never authoritative. SQLite = `proposals` (pending unconfirmed beliefs with provenance + the Slack message ts of their confirm card) and `investigations`. SQLite is disposable working memory; losing it loses no truth.

---

## 4. Layer 1 — Connectors

Design rules (all MUST):
1. **Bespoke interfaces per system** — no shared `EvidenceSource` abstraction. Abstract only over genuinely substitutable things (`LogSource` has two implementations: `SeededLogSource` for demo fixtures, real backends later).
2. **Provenance-ready returns** — every method returns permalinks/timestamps sufficient to construct `Provenance` without extra round-trips.
3. **Errors are data at the boundary:** everything crossing into the orchestrator is `ConnectorResult<T> = { ok: true; data: T } | { ok: false; reason: "auth"|"not-found"|"rate-limited"|"unavailable"; detail: string }`. The LLM receives failures as reasoning input ("Unleash unreachable → degraded confidence"), never as crashes.
4. **Connectors are dumb** — no caching, retries-with-policy, or cross-referencing inside connectors. All intelligence lives above.
5. **Summaries, not firehoses:** tool results MUST be size-curated. `query_logs` returns `{ matchCount, timeRange, topPatterns, sample: LogLine[≤10] }`; the model narrows the query if it wants more. Applies to all connectors.

```typescript
interface GitHubConnector {
  listRefs(repo: string): Promise<ConnectorResult<Array<{ name: string; type: "branch"|"tag"; lastCommitAt: string }>>>;
  readFile(repo: string, ref: string, path: string): Promise<ConnectorResult<string>>;
  createBranch(repo: string, fromRef: string, name: string): Promise<ConnectorResult<void>>;
  pushFiles(repo: string, branch: string, files: FileChange[], message: string): Promise<ConnectorResult<void>>;
  openPr(repo: string, p: { base: string; head: string; title: string; body: string }): Promise<ConnectorResult<{ url: string }>>;
}

interface UnleashConnector {
  evaluateAll(ctx: FlagContextRef): Promise<ConnectorResult<Record<string, boolean|string>>>;
  getFlagMetadata(flag: string): Promise<ConnectorResult<{ description: string; createdAt: string; stale: boolean }>>;
}

interface LogSource {
  query(q: { customer?: CustomerId; level?: "error"|"warn"; text?: string;
             window: { from: string; to: string } }): Promise<ConnectorResult<LogQuerySummary>>;
}

interface SlackSearch {   // wraps Slack RTS
  search(query: string, opts?: { channels?: string[]; before?: string; after?: string })
    : Promise<ConnectorResult<Array<{ text: string; permalink: string; author: string; ts: string }>>>;
}
```

### LLM tool menu (curated, composed — NOT 1:1 with connectors)

Intent-shaped Slack tools (decision: our code owns query construction for the two load-bearing intents; free-form is the fallback):

| Tool | Composition |
|---|---|
| `resolve_customer_state(customer)` | Registry + GitHub + Unleash fan-out via `StateResolver` |
| `diff_customer_states(a, b)` | resolver ×2 + pure `diff()` |
| `find_deploy_announcements(customer)` | SlackSearch with code-owned query templates |
| `find_prior_reports(symptom)` | SlackSearch with code-owned query templates |
| `search_slack_freeform(query)` | raw SlackSearch (fallback only) |
| `query_logs(filters)` | LogSource (summarized) |
| `read_code_at_customer_ref(customer, path)` | Registry-aware `gh.readFile` |
| `submit_diagnosis(diagnosis: Diagnosis)` | Loop exit; schema-enforced structured output |

Every tool handler, in addition to returning its result, **appends an `Evidence` object (with provenance) to the current `Investigation`** — the evidence trail is built by code, never reconstructed from model narrative.

---

## 5. Layer 2 — Orchestrator

### Routing
`App.onMention` → one cheap Haiku call → `{ mode: "query"|"investigate"|"registry-update"|"bootstrap"|"chitchat", customer?: CustomerId }` → dispatch. **The expensive loop is never the front door.** `query` mode answers via `StateResolver` directly (target: ~2s perceived).

Triage input is the mention **plus thread context** (the parent message and up to ~10 preceding thread messages) — "look into this" is classified by what "this" refers to. Triage classifies *intent only*; whether an issue is ultimately config vs code is the investigation's OUTPUT (`Diagnosis.verdict`), never a routing decision.

**Customer resolution order (MUST, in priority order):**
1. **Channel mapping:** if the message's channel ID appears in some `RegistryEntry.slackChannels`, that customer wins (dedicated/shared support channels are the primary envisioned surface).
2. **Text extraction:** customer name/identifier in the mention or thread text (Haiku extracts; must match a registry customer).
3. **Ask:** if neither resolves, the agent asks one clarifying question ("Which customer is this regarding?") and waits. NEVER launch an investigation against a guessed customer.

If mid-investigation evidence contradicts the registry (e.g. logs show a different version than the manifest), the contradiction is recorded as Evidence and the diagnosis must flag the registry as possibly stale rather than silently trusting either source.

### Passive listening (scoped)
`App.onChannelMessage` fires **only in one configured channel** (`#deploys`, env-configurable). Haiku classifier: "is this a deploy announcement?" On hit → draft `Proposal` (provenance = message permalink, `inferred-high`) → post confirm card ("📋 Looks like Acme moved to v2.5 — update the registry?" [Confirm] [Correct] [Ignore]). On confirm → `RegistryManager.apply(proposal)`. Policy: **direct commit for version bumps; PR for structural changes** (new customer, changed repo/ref shape). NO proactive issue-detection anywhere — investigation triggers only by explicit @-mention.

### Bootstrap
Not a separate machine — **a batch of the same proposal flow**. Triggered by mention ("bootstrap the registry" / first-run). Steps: run `find_deploy_announcements` per known-or-discovered customer name + `gh.listRefs` for branch/tag evidence → one synthesis LLM call clusters evidence into `Proposal[]` → post a summary card + per-customer confirm cards → confirmed proposals graduate to the manifest via PR.

### InvestigationRunner (the hand-built loop)

```typescript
async run(inv: Investigation): Promise<Diagnosis> {
  const messages = [buildInitialContext(inv)];   // see below
  for (let turn = 0; turn < MAX_TURNS /* 15 */; turn++) {
    const resp = await claude.messages.create({
      model: "claude-opus-4-8",
      system: INVESTIGATOR_PROMPT,
      messages, tools: toolRegistry.definitions(),
      max_tokens: 8192,
      // For the heavyweight turns the runner may enable extended thinking:
      // thinking: { type: "enabled", budget_tokens: 10000 }, max_tokens: 16384
    });
    if (resp.stop_reason === "tool_use") {
      const results = await executeTools(resp, inv);  // appends Evidence structurally
      messages.push(assistantMsg(resp), toolResultsMsg(results));
      await reporter.progress(inv, resp);             // short in-thread narration
      continue;
    }
    return extractDiagnosis(resp, inv);               // via submit_diagnosis tool
  }
  return inconclusiveEscalation("turn limit reached", inv);
}
```

Decisions (all MUST):
- **Front-loaded context:** before the loop, deterministic code pre-resolves the reporting customer's `ResolvedState`, pulls their `RegistryEntry` (including `notes`), and packs both into the first message with the bug report. Turns are for judgment, not lookups.
- **Progress narration** via injected `ThreadReporter` (tests use `NullReporter`). Short lines: "Resolved Acme's state (v2.3.1, 14 flags) ✓".
- **Structured exit:** the model MUST call `submit_diagnosis` to finish; prose endings are re-prompted once, then treated as inconclusive.
- **Hard ceilings:** MAX_TURNS=15, per-tool timeout (30s), total-token budget. On breach → fail CLOSED into `inconclusive` + escalation message summarizing evidence gathered. Never fail open.
- **Thread continuity:** investigations keyed by Slack thread; human replies in-thread while running/diagnosed are routed into the investigation as added context.
- **Approval gate (MANDATORY):** a `code-issue` diagnosis posts with an "Attempt fix →" button. The CodeFixer NEVER launches without that click.

### INVESTIGATOR_PROMPT (system prompt, summary of required content)
Role: deployment-aware debugging investigator. You have the reporting customer's resolved state and registry notes. Method: corroborate the symptom (logs, prior reports) → identify a healthy comparison customer → diff states → interpret the delta against the symptom → read code at the customer's ref only as needed → decide config-issue vs code-issue vs inconclusive. Cite evidence for every claim. Evidence tiers, strongest→weakest: live flag API > git > logs > Slack testimony. Prefer fewer, higher-level tool calls. When confident, call `submit_diagnosis`; if evidence conflicts or runs out, verdict=inconclusive with an honest summary — never guess.

---

## 6. Layer 3 — CodeFixer

Interface to the rest of the system is exactly: `attemptFix(brief: CodeFixBrief): Promise<FixOutcome>`.

### Sandbox — Tier 2 primary, Tier 1 fallback
- **Tier 2 (primary):** each fix attempt runs in a Docker container with **`--network=none`** after init. Init phase (network on, before the agent loop): clone repo at `brief.ref` (`--depth 1`), `npm install`. Then network off, Agent SDK runs inside. Workspace mounted so the wrapper can verify from outside (or verification runs inside and results are copied out — implementer's choice, but `VerificationReport` MUST be computed by wrapper-controlled code, not extracted from model claims).
- **Tier 1 (fallback, behind the same `WorkspaceManager` interface):** `mkdtemp` on host, SDK tools scoped to the directory. Use if Docker plumbing threatens the schedule.
- **Tier 3 (roadmap only, do not build):** cloud sandbox (E2B/Modal/Managed Agents sessions) as an alternate `WorkspaceManager` implementation.

### Security invariants (MUST)
- **The GitHub token never enters the sandbox.** The SDK works in a local clone with no credentials. Branch creation, push, and PR opening are performed by the **wrapper** via `GitHubConnector` after the sandbox exits.
- **No network access inside the agent loop** (Tier 2 enforces physically; Tier 1 approximates via tool scoping). Everything the fixer needs arrives in the brief. If the fixer "needs" live context, that is a diagnosis-phase bug — surface it, don't work around it.

### Fixer prompt (work order structure — templated from the brief, MUST enforce reproduce-first)
1. You are fixing a bug in a **customer-pinned deployment** at ref `{ref}`. Do not rebase; do not port from main.
2. **Step 1 — Reproduce:** write a failing test demonstrating the bug under `{reproductionConditions}` (evidence attached: `{evidence}`). Do not proceed until the test fails for the expected reason. If you cannot reproduce, stop and report why.
3. **Step 2 — Fix:** minimal change; match repo style; constraints: `{constraints}`.
4. **Step 3 — Verify:** run the full test suite.
5. **Step 4 — Report:** write `FIX_REPORT.md` (root cause, change rationale, risk notes).

### Outcome handling
- Verified (repro test present, fails-on-original, passes-on-fixed, suite green) → wrapper pushes branch `deploycontext/fix-{investigationId}` and opens PR against `brief.ref`'s branch (or a maintenance branch for tag pins) → `pr-opened`.
- Fix exists but verification incomplete → push branch, NO PR → `fix-unverified` with branch URL.
- Reproduction failed → `no-repro`; the orchestrator posts this back to the thread as a diagnosis-was-wrong signal and escalates. (`no-repro` is information, not failure.)
- Timeout (10 min wall clock) / turn-cap breach → kill container, `failed` with transcript attached to the escalation.

### PR body (templated by wrapper from the causal chain — this is the product's face)
Bug report (Slack permalink) → customer + resolved state → diagnosis with evidence citations → reproduction test description → fix rationale (from FIX_REPORT.md) → VerificationReport table → "Generated by DeployContext" footer.

---

## 7. Demo environment (build this FIRST — everything downstream needs a target)

### Fake product repo (`fake-product`)
A small TypeScript SaaS backend ("export service" is enough): a few modules, a test suite (vitest/jest), config loading from `customers/{id}/values.yaml`, flags read via Unleash SDK.
- **Refs:** tag `acme-prod-v2.3.1` (customer Acme's pin) and `main` (v2.5.0, customer Beta).
- **Seeded bug:** on `acme-prod-v2.3.1`, the export path has an unguarded interaction when `new_billing=on` AND `legacy_export=off` (e.g. new-billing export formatter assumes the legacy exporter populated a field). `main` contains the guard (so Beta is healthy). The bug MUST be: reproducible by a test, findable from the log line, fixable in ≤ ~15 lines.
- `deployments.yaml` lives here; `customers/acme/values.yaml` and `customers/beta/values.yaml` exist and differ in at least one plausible setting.

### Unleash
Self-hosted via docker-compose (Unleash OSS + Postgres). Flags: `new_billing`, `legacy_export`, plus 6–10 decoys. Strategy overrides so Acme's context evaluates `new_billing=on, legacy_export=off` and Beta's evaluates healthy values.

### Seeded logs
`fixtures/logs.json`: ~200 lines of plausible app logs across both customers; the smoking gun for Acme: `ERROR export_service: cannot read field 'ledgerRef' — customer=acme version=2.3.1 flags=new_billing,!legacy_export` (a handful of occurrences, timestamped in the report window), plus noise. `SeededLogSource` reads this file.

### Slack sandbox setup & seeding

**Sandbox:** provisioned via the Slack Developer Program (Sandboxes → Provision Sandbox), **empty template**. Sandboxes support up to 8 users; two active sandboxes allowed at a time; ~6-month lifespan. The two team members join as real users and play the live personas (client reporting the bug; engineer tagging the agent; approver). Judge access: invite `slackhack@salesforce.com` and `testing@devpost.com`; if a domain allowlist is configured, it MUST admit those domains; test the invite flow before submitting.

**Channels:** `#deploys` (historical deploy announcements), `#support-acme` (client-facing; listed in Acme's `slackChannels` so triage resolves the customer from the channel), `#eng-general` (noise).

**Seed script (`scripts/seed-slack.ts`) — REQUIRED, part of the repo:**
- Posts the entire historical message layer in one idempotent command so the demo world is reproducible after any re-provision or wording iteration.
- Uses `chat.postMessage` with `username` + `icon_url` overrides so historical messages appear from varied team personas ("sam-eng", "priya-support"). This requires the **`chat:write.customize`** bot scope — add it to the app manifest alongside the other scopes.
- Content: (a) `#deploys`: announcements incl. "Shipped acme-prod-v2.3.1 to Acme" and Beta's v2.5 announcement, each with an in-text date (message timestamps will all be seeding-day; in-text dates carry the provenance story); (b) `#support-acme`: one prior vague Acme export complaint; (c) 20–30 filler messages across channels (standup notes, CI chatter, off-topic) so bootstrap's RTS mining is a real retrieval task, not needle-in-needle-stack.
- Messages seeded via username override carry a small APP badge on close inspection — acceptable for background history. All **on-camera** messages (the live bug report, the @-mention, button clicks) MUST come from the real invited user accounts, not the script.
- Script reads its message set from a checked-in `fixtures/slack-seed.json` so wording can be iterated without code changes (the deploy-announcement wording WILL be tuned while testing bootstrap parsing).

---

## 8. Configuration & secrets

Env vars: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` (socket mode), `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` (bot account PAT), `GITHUB_REPO`, `UNLEASH_URL`, `UNLEASH_API_TOKEN`, `DEPLOY_CHANNEL_ID`, `MANIFEST_PATH` (default `deployments.yaml`), `LOG_FIXTURES_PATH`, `SQLITE_PATH`, `WORKSPACE_TIER` (`docker`|`tempdir`).

**`.env.example` (REQUIRED, checked in):** every env var above, each with a one-line comment explaining what it is and where to obtain it (e.g. which Slack app settings page issues `SLACK_APP_TOKEN`, that `GITHUB_TOKEN` is a bot-account PAT needing `repo` scope, where Unleash API tokens are created). Real `.env` is gitignored; secrets are NEVER committed.

**Startup validation:** on boot, the app validates that all required env vars are present and fails fast with a clear message naming the missing ones — no partial startup with cryptic downstream errors.

**`README.md` (REQUIRED, repo root):** written for a developer who has never seen this project. MUST contain:
1. **What it is:** 2–3 paragraph project description (problem → what the agent does → the registry thesis). May be adapted from §1 of this brief.
2. **Architecture at a glance:** the ASCII diagram from §2 + one paragraph per layer.
3. **Prerequisites:** Node version, Docker, a Slack developer sandbox, Anthropic API key, GitHub bot account, Unleash (docker-compose provided).
4. **Setup, step by step:** clone → `cp .env.example .env` and fill it (with pointers per key) → start Unleash (`docker compose up`) → configure flags (or run the provided setup script) → create the Slack app from the included manifest → install to the sandbox → run `scripts/seed-slack.ts`.
5. **Running:** `npm start`, what healthy startup logs look like.
6. **Verify it works (smoke checklist, in order):**
   - App boots with no missing-env errors and logs "connected" for Slack socket mode.
   - `@agent what is Acme running?` in the sandbox → resolved state with provenance in a few seconds (proves Slack + registry + GitHub + Unleash all work).
   - `@agent bootstrap the registry` in a seeded channel → proposal cards appear (proves RTS mining).
   - Post the demo bug report, tag the agent → diagnosis card with "Attempt fix" button (proves the investigation loop).
   - Click "Attempt fix" → PR link posted in-thread (proves the fixer sandbox + GitHub write path). Note expected duration (~5–10 min).
7. **Troubleshooting:** the 5–6 most likely failures (bad/expired Slack tokens, Unleash unreachable, Docker not running → falls back or errors per `WORKSPACE_TIER`, missing GitHub scopes, judge can't log in to sandbox) each with its fix.
8. **Repo map:** one line per top-level directory.

---

## 9. Repo structure (suggested)

```
deploycontext/
  README.md                # per §8: description, setup, run, smoke checklist, troubleshooting
  .env.example             # per §8: every env var, commented; real .env is gitignored
  src/
    app.ts                 # Slack socket-mode wiring, router, action handlers
    triage.ts              # Haiku mode classifier
    domain/types.ts        # Layer 0 (verbatim from this brief)
    registry/
      manifest.ts          # YAML parse/serialize, schema validation
      registry.ts          # cache + read API
      manager.ts           # apply proposals → commit/PR via GitHubConnector
      proposals.ts         # ProposalStore (SQLite)
    resolve/
      resolver.ts          # StateResolver
      diff.ts              # pure diff() — unit tests required
    connectors/
      github.ts  unleash.ts  logs.ts  slackSearch.ts  types.ts  fakes/
    investigate/
      runner.ts            # InvestigationRunner
      tools.ts             # ToolRegistry: curated menu + Evidence side-effects
      prompts.ts           # INVESTIGATOR_PROMPT
      store.ts             # InvestigationStore (SQLite)
      reporter.ts          # ThreadReporter + NullReporter
    bootstrap/flow.ts
    deploywatch/listener.ts
    fixer/
      codefixer.ts  workspace.ts   # WorkspaceManager: DockerWorkspace | TempDirWorkspace
      fixPrompt.ts  verify.ts  prBody.ts
  fixtures/logs.json
  docker/fixer.Dockerfile
  test/                    # diff, resolver (against fakes), runner (fake connectors + scripted LLM), verify
```

## 10. Build order (dependency-ordered milestones)

1. **M0 — Demo world:** fake-product repo with seeded bug + refs + config files; Unleash compose + flags; log fixtures; Slack sandbox provisioned + `scripts/seed-slack.ts` posting the historical layer from `fixtures/slack-seed.json`. *Exit test: bug reproduces by hand under Acme's flags at the tag; guard on main prevents it; seed script runs idempotently against a fresh channel set.*
2. **M1 — Deterministic core:** types, manifest parse, Registry, connectors (+fakes), StateResolver, pure diff. *Exit: unit tests pass; `resolve(acme)` correct against real Unleash + GitHub.*
3. **M2 — Slack surface + fast path:** socket-mode app, triage, query mode. *Exit: "@agent what is Acme running?" answers with provenance in ~2s.*
4. **M3 — Investigation loop:** ToolRegistry, runner, reporter, diagnosis card + gate button. *Exit: demo bug report → correct `code-issue` diagnosis citing the flag delta, ≥8/10 runs.*
5. **M4 — CodeFixer:** WorkspaceManager (tempdir first, then Docker), fixer prompt, verification, PR assembly. *Exit: button click → verified PR against the tag's fix branch, ≥8/10 runs.*
6. **M5 — Bootstrap + deploy-watch:** proposal flow, confirm cards, RTS mining, #deploys listener. *Exit: fresh sandbox → proposed registry matching seeded history; announcement → bump proposal.*
7. **M6 — Hardening + ops + docs:** VPS deploy, judge access, complete `README.md` per §8 (smoke checklist + troubleshooting written from real observed behavior, not guessed), verify `.env.example` matches every env var actually read by the code, rehearse full storyboard 3×, film.

Note: `.env.example` and a skeleton `README.md` (description + setup-so-far) are created in M2 and kept current at every milestone; M6 finalizes them.

If schedule slips: cut Docker (Tier 1 fallback), cut deploy-watch listener (demo the same beat via @-mention), cut extended thinking. NEVER cut: provenance, the approval gate, reproduce-first, wrapper-computed verification.

## 11. Non-goals (v1) / Roadmap
Out of scope: proactive issue detection in channels; container-registry connector (roadmap: GHCR/ECR as an evidence source); cloud sandboxes (roadmap: Tier 3 `WorkspaceManager`); GitHub App auth (roadmap; PAT for v1); OpenFeature abstraction over flag providers (roadmap; Unleash-only for v1); multi-workspace tenancy; auto-applied fixes without human gates (never).