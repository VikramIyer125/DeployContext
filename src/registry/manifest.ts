/**
 * deployments.yaml parse / validate / serialize.
 *
 * The manifest is the source of truth and is human-readable; it stores
 * descriptors plus per-fact provenance. Parsing assembles Attested<T> values;
 * serialization is canonical block-style YAML (used by RegistryManager when
 * applying proposals).
 */
import { load, dump } from "js-yaml";
import type { Provenance, RegistryEntry } from "../domain/types.js";

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

const CONFIDENCES = new Set(["confirmed", "inferred-high", "inferred-low"]);
const SOURCES = new Set(["slack", "github", "unleash", "logs", "human"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseProvenance(raw: unknown, where: string): Provenance[] {
  if (raw === undefined || raw === null) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map((item, i) => {
    if (!isRecord(item)) throw new ManifestError(`${where}: provenance[${i}] must be a mapping`);
    const source = String(item.source ?? "");
    const confidence = String(item.confidence ?? "");
    if (!SOURCES.has(source)) {
      throw new ManifestError(`${where}: provenance[${i}].source "${source}" invalid`);
    }
    if (!CONFIDENCES.has(confidence)) {
      throw new ManifestError(`${where}: provenance[${i}].confidence "${confidence}" invalid`);
    }
    return {
      source: source as Provenance["source"],
      evidenceUrl: String(item.evidenceUrl ?? ""),
      observedAt: String(item.observedAt ?? ""),
      confidence: confidence as Provenance["confidence"],
    };
  });
}

function requireString(v: unknown, where: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new ManifestError(`${where} must be a non-empty string`);
  }
  return v;
}

function parseEntry(customer: string, raw: unknown): RegistryEntry {
  if (!isRecord(raw)) throw new ManifestError(`customer "${customer}" must be a mapping`);
  const where = `customers.${customer}`;

  const code = raw.code;
  if (!isRecord(code)) throw new ManifestError(`${where}.code must be a mapping`);
  const refType = code.refType;
  if (refType !== "branch" && refType !== "tag") {
    throw new ManifestError(`${where}.code.refType must be "branch" or "tag"`);
  }

  const flagContext = raw.flagContext;
  if (!isRecord(flagContext) || flagContext.provider !== "unleash" || !isRecord(flagContext.context)) {
    throw new ManifestError(`${where}.flagContext must be { provider: unleash, context: {...} }`);
  }

  let config: RegistryEntry["config"] = null;
  if (raw.config !== undefined && raw.config !== null) {
    if (!isRecord(raw.config)) throw new ManifestError(`${where}.config must be a mapping or null`);
    config = {
      repo: requireString(raw.config.repo, `${where}.config.repo`),
      path: requireString(raw.config.path, `${where}.config.path`),
    };
  }

  const provenance = isRecord(raw.provenance) ? raw.provenance : {};

  const notes = raw.notes === undefined || raw.notes === null ? [] : raw.notes;
  if (!Array.isArray(notes)) throw new ManifestError(`${where}.notes must be a list`);

  const slackChannels = raw.slackChannels === undefined || raw.slackChannels === null ? [] : raw.slackChannels;
  if (!Array.isArray(slackChannels)) throw new ManifestError(`${where}.slackChannels must be a list`);

  return {
    customer,
    displayName: requireString(raw.displayName, `${where}.displayName`),
    code: {
      repo: requireString(code.repo, `${where}.code.repo`),
      refType,
      ref: {
        value: requireString(code.ref, `${where}.code.ref`),
        provenance: parseProvenance(provenance.ref, `${where}`),
      },
    },
    versionPin: {
      value: requireString(raw.versionPin, `${where}.versionPin`),
      provenance: parseProvenance(provenance.versionPin, `${where}`),
    },
    flagContext: {
      provider: "unleash",
      context: Object.fromEntries(
        Object.entries(flagContext.context).map(([k, v]) => [k, String(v)]),
      ),
    },
    config,
    notes: notes.map((n) => String(n)),
    slackChannels: slackChannels.map((c) => String(c)),
  };
}

export function parseManifest(yamlText: string): RegistryEntry[] {
  let doc: unknown;
  try {
    doc = load(yamlText);
  } catch (e) {
    throw new ManifestError(`invalid YAML: ${(e as Error).message}`);
  }
  if (!isRecord(doc) || !isRecord(doc.customers)) {
    throw new ManifestError(`manifest must have a top-level "customers" mapping`);
  }
  return Object.entries(doc.customers).map(([id, raw]) => parseEntry(id, raw));
}

function provenanceToYaml(p: Provenance[]): unknown {
  if (p.length === 0) return undefined;
  const objs = p.map((x) => ({
    source: x.source,
    evidenceUrl: x.evidenceUrl,
    observedAt: x.observedAt,
    confidence: x.confidence,
  }));
  return objs.length === 1 ? objs[0] : objs;
}

export function serializeManifest(entries: RegistryEntry[]): string {
  const customers: Record<string, unknown> = {};
  for (const e of entries) {
    const provenance: Record<string, unknown> = {};
    const versionPinProv = provenanceToYaml(e.versionPin.provenance);
    const refProv = provenanceToYaml(e.code.ref.provenance);
    if (versionPinProv) provenance.versionPin = versionPinProv;
    if (refProv) provenance.ref = refProv;

    customers[e.customer] = {
      displayName: e.displayName,
      code: { repo: e.code.repo, refType: e.code.refType, ref: e.code.ref.value },
      versionPin: e.versionPin.value,
      flagContext: { provider: e.flagContext.provider, context: e.flagContext.context },
      config: e.config ? { repo: e.config.repo, path: e.config.path } : null,
      slackChannels: e.slackChannels ?? [],
      notes: e.notes,
      ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
    };
  }
  const header = "# deployments.yaml — maintained by DeployContext. Edit via PR.\n";
  return header + dump({ customers }, { lineWidth: 100, noRefs: true });
}
