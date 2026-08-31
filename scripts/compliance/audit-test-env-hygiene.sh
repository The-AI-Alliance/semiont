#!/usr/bin/env bash
set -euo pipefail

# Audit: test-env hygiene (H1) — no test file exports a SEMIONT_* env var
# that no production file in the same workspace reads. A test setup that
# fabricates deployment env keeps dead requirements alive: the
# SINGLE-KB-MOUNT live gates found 114 auth tests green against an image
# that could not boot, because both gateway test setups exported
# SEMIONT_ROOT themselves. When a requirement is removed from production,
# this gate forces the fiction out of the tests in the same change.
#
# Scoped to SEMIONT_* — the deployment-contract namespace. Test knobs like
# NODE_ENV or VITEST_* are not deployment facts and stay out of scope.
#
# Exit code: 0 if clean, 1 if violations found.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

FAIL=0
is_test_file() { echo "$1" | grep -qE '__tests__|test-setup|\.test\.ts$|vitest\.setup'; }

for tree in apps/gateway apps/browser packages/*; do
  [ -d "$tree/src" ] || continue

  writes=""
  reads=""
  while IFS= read -r f; do
    if is_test_file "$f"; then
      w=$(grep -hoE 'process\.env\.SEMIONT_[A-Z_]+ *=[^=]' "$f" 2>/dev/null \
        | grep -oE 'SEMIONT_[A-Z_]+' || true)
      writes=$(printf '%s\n%s' "$writes" "$w")
    else
      r=$(grep -hoE 'process\.env\.SEMIONT_[A-Z_]+' "$f" 2>/dev/null \
        | grep -oE 'SEMIONT_[A-Z_]+' || true)
      reads=$(printf '%s\n%s' "$reads" "$r")
    fi
  done < <(find "$tree/src" -name '*.ts' 2>/dev/null)

  writes=$(echo "$writes" | grep -v '^$' | sort -u || true)
  reads=$(echo "$reads" | grep -v '^$' | sort -u || true)

  for var in $writes; do
    if ! echo "$reads" | grep -qxF "$var"; then
      echo "❌ H1: $tree tests export \$$var but nothing in $tree/src outside the tests reads it — delete the export with the requirement it once served:"
      grep -rlnE "process\.env\.$var *=" "$tree/src" 2>/dev/null \
        | while IFS= read -r f; do is_test_file "$f" && echo "     $f"; done
      FAIL=1
    fi
  done
done

if [ "$FAIL" -eq 0 ]; then
  echo "✅ test-env hygiene clean (H1: every SEMIONT_* var a test exports is read by production code in the same workspace)"
fi
exit "$FAIL"
