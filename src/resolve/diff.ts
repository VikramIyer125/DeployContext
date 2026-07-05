/**
 * Pure diff between two resolved customer states. No LLM involvement, no I/O.
 */
import type { ResolvedState, StateDelta } from "../domain/types.js";

export function diff(a: ResolvedState, b: ResolvedState): StateDelta {
  return {
    a: a.customer,
    b: b.customer,
    versionDelta:
      a.version.value === b.version.value
        ? null
        : { a: a.version.value, b: b.version.value },
    flagDeltas: flagDeltas(a.flags.value, b.flags.value),
    configDeltas: configDeltas(a.config.value, b.config.value),
  };
}

function flagDeltas(
  a: Record<string, boolean | string>,
  b: Record<string, boolean | string>,
): StateDelta["flagDeltas"] {
  const flags = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const deltas: StateDelta["flagDeltas"] = [];
  for (const flag of flags) {
    if (!Object.is(a[flag], b[flag])) {
      deltas.push({ flag, a: a[flag], b: b[flag] });
    }
  }
  return deltas;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-diffs config objects into dotted-path deltas. Recurses into plain
 * objects only; arrays and scalars are compared atomically (a differing array
 * yields one delta at the array's path).
 */
function configDeltas(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  prefix = "",
): StateDelta["configDeltas"] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const deltas: StateDelta["configDeltas"] = [];
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const av = a[key];
    const bv = b[key];
    if (isPlainObject(av) && isPlainObject(bv)) {
      deltas.push(...configDeltas(av, bv, path));
    } else if (!atomicEqual(av, bv)) {
      deltas.push({ path, a: av, b: bv });
    }
  }
  return deltas;
}

function atomicEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => atomicEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    // Only reached for objects nested inside arrays (top-level plain objects recurse).
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return (
      ka.length === kb.length &&
      ka.every((k, i) => k === kb[i] && atomicEqual(a[k], b[k]))
    );
  }
  return false;
}
