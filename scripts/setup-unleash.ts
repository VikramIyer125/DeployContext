/**
 * Idempotent Unleash setup for the DeployContext demo world.
 *
 * Creates the demo flags in the default project, converges their production
 * strategies to the spec below (delete + recreate), then verifies evaluation
 * as each customer using the real client SDK.
 *
 * Env (defaults match docker-compose.yml):
 *   UNLEASH_URL          default http://localhost:4242
 *   UNLEASH_ADMIN_TOKEN  admin API token
 *   UNLEASH_API_TOKEN    client API token (production env)
 */
import { initialize } from "unleash-client";

const UNLEASH_URL = process.env.UNLEASH_URL ?? "http://localhost:4242";
const ADMIN_TOKEN =
  process.env.UNLEASH_ADMIN_TOKEN ?? "*:*.deploycontext-insecure-admin-token";
const CLIENT_TOKEN =
  process.env.UNLEASH_API_TOKEN ??
  "default:production.deploycontext-insecure-client-token";
const PROJECT = "default";
const ENVIRONMENT = "production";

type Strategy =
  | "all" // enabled for everyone
  | "off" // disabled in production
  | { onlyFor: string } // enabled only for this userId
  | { exceptFor: string }; // enabled for everyone except this userId

interface FlagSpec {
  name: string;
  description: string;
  strategy: Strategy;
}

const FLAGS: FlagSpec[] = [
  // The two flags that matter for the seeded bug:
  {
    name: "new_billing",
    description: "New-billing export format (rolling out per customer)",
    strategy: { onlyFor: "acme" },
  },
  {
    name: "legacy_export",
    description: "Legacy export pipeline (being phased out)",
    strategy: { exceptFor: "acme" },
  },
  // Decoys:
  { name: "dark_mode_v2", description: "Dark mode revamp", strategy: "all" },
  { name: "audit_log_v2", description: "Structured audit log events", strategy: "all" },
  { name: "sso_enforced", description: "Enforce SSO for all seats", strategy: "all" },
  { name: "rate_limiter_v2", description: "Token-bucket rate limiter", strategy: "all" },
  { name: "beta_dashboard", description: "Preview dashboard for design partners", strategy: { onlyFor: "beta" } },
  { name: "csv_streaming", description: "Stream CSV exports instead of buffering", strategy: "off" },
  { name: "new_onboarding", description: "Reworked onboarding flow", strategy: "off" },
  { name: "export_parallelism", description: "Parallel batch export workers", strategy: "off" },
];

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${UNLEASH_URL}${path}`, {
    method,
    headers: { Authorization: ADMIN_TOKEN, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function waitForUnleash(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${UNLEASH_URL}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Unleash not reachable at ${UNLEASH_URL} after ${timeoutMs / 1000}s`);
}

function constraintsFor(strategy: Strategy): unknown[] {
  if (strategy === "all" || strategy === "off") return [];
  const [operator, value] =
    "onlyFor" in strategy ? ["IN", strategy.onlyFor] : ["NOT_IN", strategy.exceptFor];
  return [
    {
      contextName: "userId",
      operator,
      values: [value],
      caseInsensitive: false,
      inverted: false,
    },
  ];
}

async function ensureFlag(spec: FlagSpec): Promise<void> {
  const base = `/api/admin/projects/${PROJECT}/features`;

  const create = await api("POST", base, {
    name: spec.name,
    description: spec.description,
    type: "release",
    impressionData: false,
  });
  if (!create.ok && create.status !== 409) {
    throw new Error(`create ${spec.name}: ${create.status} ${await create.text()}`);
  }

  // Converge: remove existing production strategies, then add the desired one.
  const envBase = `${base}/${spec.name}/environments/${ENVIRONMENT}`;
  const stratRes = await api("GET", `${envBase}/strategies`);
  if (!stratRes.ok) {
    throw new Error(`list strategies ${spec.name}: ${stratRes.status} ${await stratRes.text()}`);
  }
  const existing = (await stratRes.json()) as Array<{ id: string }>;
  for (const s of existing) {
    await api("DELETE", `${envBase}/strategies/${s.id}`);
  }

  if (spec.strategy === "off") {
    const off = await api("POST", `${envBase}/off`);
    if (!off.ok) throw new Error(`disable ${spec.name}: ${off.status}`);
    return;
  }

  const addStrat = await api("POST", `${envBase}/strategies`, {
    name: "flexibleRollout",
    constraints: constraintsFor(spec.strategy),
    parameters: { rollout: "100", stickiness: "default", groupId: spec.name },
  });
  if (!addStrat.ok) {
    throw new Error(`add strategy ${spec.name}: ${addStrat.status} ${await addStrat.text()}`);
  }
  const on = await api("POST", `${envBase}/on`);
  if (!on.ok) throw new Error(`enable ${spec.name}: ${on.status} ${await on.text()}`);
}

/** Expected per-customer evaluations, verified below with the client SDK. */
const EXPECTATIONS: Record<string, Record<string, boolean>> = {
  acme: {
    new_billing: true,
    legacy_export: false,
    dark_mode_v2: true,
    beta_dashboard: false,
    csv_streaming: false,
  },
  beta: {
    new_billing: false,
    legacy_export: true,
    dark_mode_v2: true,
    beta_dashboard: true,
    csv_streaming: false,
  },
};

async function verify(): Promise<void> {
  const unleash = initialize({
    url: `${UNLEASH_URL}/api/`,
    appName: "deploycontext-setup-verify",
    customHeaders: { Authorization: CLIENT_TOKEN },
    disableMetrics: true,
  });
  await new Promise<void>((resolve, reject) => {
    unleash.on("synchronized", () => resolve());
    unleash.on("error", (err) => reject(err));
  });

  let failures = 0;
  for (const [customer, flags] of Object.entries(EXPECTATIONS)) {
    for (const [flag, expected] of Object.entries(flags)) {
      const actual = unleash.isEnabled(flag, { userId: customer, environment: ENVIRONMENT });
      const ok = actual === expected;
      if (!ok) failures++;
      console.log(
        `${ok ? "✓" : "✗"} ${customer.padEnd(5)} ${flag.padEnd(20)} expected=${expected} actual=${actual}`,
      );
    }
  }
  unleash.destroy();
  if (failures > 0) {
    throw new Error(`${failures} flag evaluation(s) did not match expectations`);
  }
}

async function main(): Promise<void> {
  console.log(`Waiting for Unleash at ${UNLEASH_URL}…`);
  await waitForUnleash();
  for (const spec of FLAGS) {
    await ensureFlag(spec);
    console.log(`configured ${spec.name} (${JSON.stringify(spec.strategy)})`);
  }
  console.log("\nVerifying evaluation as each customer…");
  await verify();
  console.log("\n✓ Unleash demo flags configured and verified");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
