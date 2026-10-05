#!/usr/bin/env bash
set -euo pipefail

# Audit: the compliance audits can fail.
#
# batch-audit.ts and batch-audit-tests.ts report on a tree and exit non-zero
# when something in it fails. CI and audit-all-compliance.sh act on that exit
# status and on nothing else, so a status that is always zero is a gate that
# passes everything. A report cannot show that: a passing run of a gate that
# cannot fail looks the same as a passing run of one that can.
#
# So this plants one violation each audit must refuse, in a scratch tree, and
# requires a non-zero exit; then a clean tree, and requires zero. The clean
# case is what tells a refusal apart from an audit that merely crashed.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPLIANCE_DIR="$REPO_ROOT/scripts/compliance"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

fail=0

# expect <pass|refuse> <what> <command...>
expect() {
  local want="$1" what="$2"
  shift 2
  local status=0
  "$@" > /dev/null 2>&1 || status=$?
  if [ "$want" = pass ] && [ "$status" -ne 0 ]; then
    echo "❌ $what: exit $status, expected 0"
    fail=1
  elif [ "$want" = refuse ] && [ "$status" -eq 0 ]; then
    echo "❌ $what: exit 0, expected a refusal"
    fail=1
  else
    echo "✅ $what (exit $status)"
  fi
}

# ── Source audit: a callback prop in a dependency array (tenet 2) ──────────────

mkdir -p "$scratch/planted" "$scratch/clean"

cat > "$scratch/planted/Planted.tsx" <<'TSX'
import { useEffect } from 'react';

export function Planted({ onDone }: { onDone: () => void }) {
  useEffect(() => { onDone(); }, [onDone]);
  return null;
}
TSX
echo '[{"name":"Planted","type":"component","file":"Planted.tsx","lineNumber":3,"exported":true}]' > "$scratch/planted/symbols.json"

cat > "$scratch/clean/Clean.tsx" <<'TSX'
import { useEffect, useRef } from 'react';

export function Clean({ onDone }: { onDone: () => void }) {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => { onDoneRef.current(); }, []);
  return null;
}
TSX
echo '[{"name":"Clean","type":"component","file":"Clean.tsx","lineNumber":3,"exported":true}]' > "$scratch/clean/symbols.json"

expect refuse "batch-audit refuses a callback prop in a dependency array" \
  npx tsx "$COMPLIANCE_DIR/batch-audit.ts" "$scratch/planted" "$scratch/planted/symbols.json"
expect pass "batch-audit passes the same component written with a ref" \
  npx tsx "$COMPLIANCE_DIR/batch-audit.ts" "$scratch/clean" "$scratch/clean/symbols.json"

# ── Test audit: a spy on the event bus ──────────────────────────────────────────

mkdir -p "$scratch/planted-tests/__tests__" "$scratch/clean-tests/__tests__"

cat > "$scratch/planted-tests/__tests__/planted.test.ts" <<'TS'
import { vi, it } from 'vitest';

declare const eventBus: { emit: (channel: string, payload: unknown) => void };

it('spies on the bus', () => {
  vi.spyOn(eventBus, 'emit');
});
TS

cat > "$scratch/clean-tests/__tests__/clean.test.ts" <<'TS'
import { expect, it } from 'vitest';

it('adds', () => {
  expect(1 + 1).toBe(2);
});
TS

expect refuse "batch-audit-tests refuses a spy on the event bus" \
  npx tsx "$COMPLIANCE_DIR/batch-audit-tests.ts" "$scratch/planted-tests"
expect pass "batch-audit-tests passes a test with no such spy" \
  npx tsx "$COMPLIANCE_DIR/batch-audit-tests.ts" "$scratch/clean-tests"

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "A compliance audit did not answer a planted violation with a failure, or failed a clean tree."
  echo "Its exit status is what CI reads: see batch-audit.ts and batch-audit-tests.ts."
  exit 1
fi
