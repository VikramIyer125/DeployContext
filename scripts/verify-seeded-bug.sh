#!/usr/bin/env bash
# M0 exit test: proves the seeded bug reproduces under Acme's flag combination
# (new_billing=on, legacy_export=off) at tag acme-prod-v2.3.1, and that the
# guard on main prevents it. Injects scripts/repro/acme-flag-combo.repro.test.ts
# into a fresh checkout of each ref and runs vitest.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${1:-$SCRIPT_DIR/../fake-product}"
REPRO_TEST="$SCRIPT_DIR/repro/acme-flag-combo.repro.test.ts"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

check_ref() {
  local ref="$1" expectation="$2" # expectation: fail | pass
  local dir="$WORK/$ref"
  echo "── checking $ref (expect repro test to $expectation)"
  git clone -q --depth 1 --branch "$ref" "file://$(cd "$REPO_DIR" && pwd)" "$dir"
  (cd "$dir" && npm install --silent --no-fund --no-audit >/dev/null 2>&1)
  cp "$REPRO_TEST" "$dir/test/"

  local outcome
  if (cd "$dir" && npx vitest run >"$WORK/$ref.log" 2>&1); then
    outcome="pass"
  else
    outcome="fail"
  fi

  if [[ "$outcome" != "$expectation" ]]; then
    echo "✗ $ref: repro test ${outcome}ed, expected to $expectation"
    tail -30 "$WORK/$ref.log"
    exit 1
  fi

  if [[ "$expectation" == "fail" ]]; then
    if ! grep -q "cannot read field 'ledgerRef'" "$WORK/$ref.log"; then
      echo "✗ $ref: repro test failed, but not with the expected error"
      tail -30 "$WORK/$ref.log"
      exit 1
    fi
    echo "✓ $ref: repro test fails with \"cannot read field 'ledgerRef'\""
  else
    echo "✓ $ref: repro test passes (guard present)"
  fi
}

check_ref acme-prod-v2.3.1 fail
check_ref main pass
echo "✓ seeded bug verified: reproduces at the tag, guarded on main"
