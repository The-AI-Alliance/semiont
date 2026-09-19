#!/usr/bin/env bash
set -euo pipefail

# Audit: test-env hygiene (H1) — no test file exports a SEMIONT_* env var
# that no production code in the same PROCESS reads. A test setup that
# fabricates deployment env keeps dead requirements alive: the
# SINGLE-KB-MOUNT live gates found 114 auth tests green against an image
# that could not boot, because both gateway test setups exported
# SEMIONT_ROOT themselves. When a requirement is removed from production,
# this gate forces the fiction out of the tests in the same change.
#
# A process is its own source PLUS the workspace packages it imports, so the
# reads are collected over the dependency closure. Scoped to `$tree/src`
# alone, this gate called a live requirement dead: apps/gateway needs
# SEMIONT_OIDC_CLIENT_ID because `archivistEndpoint` reads it on the
# gateway's behalf, and that function lives in @semiont/core.
#
# Scoped to SEMIONT_* — the deployment-contract namespace. Test knobs like
# NODE_ENV or VITEST_* are not deployment facts and stay out of scope.
#
# Exit code: 0 if clean, 1 if violations found.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

FAIL=0
is_test_file() { echo "$1" | grep -qE '__tests__|test-setup|\.test\.ts$|vitest\.setup'; }

# Reads per workspace directory, computed once. apps/gateway's closure is most
# of packages/*, and every package computes its own closure, so without this
# the same trees get re-scanned a dozen times.
READS_CACHE=$(mktemp -d)
trap 'rm -rf "$READS_CACHE"' EXIT

package_reads() {
  local dir="$1"
  local cache="$READS_CACHE/${dir//\//_}"
  if [ ! -f "$cache" ]; then
    : > "$cache"
    if [ -d "$dir/src" ]; then
      while IFS= read -r f; do
        is_test_file "$f" && continue
        grep -hoE 'process\.env\.SEMIONT_[A-Z_]+' "$f" 2>/dev/null \
          | grep -oE 'SEMIONT_[A-Z_]+' >> "$cache" || true
      done < <(find "$dir/src" -name '*.ts' 2>/dev/null)
    fi
  fi
  cat "$cache"
}

# Every workspace directory whose code runs in this tree's process: itself,
# plus the transitive `@semiont/*` dependencies it imports.
dep_closure() {
  node -e '
const fs = require("fs");
const path = require("path");
const seen = new Set();
const visit = (dir) => {
  if (seen.has(dir)) return;
  seen.add(dir);
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
  } catch {
    return;
  }
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (!name.startsWith("@semiont/")) continue;
    const dep = path.join("packages", name.slice("@semiont/".length));
    if (fs.existsSync(path.join(dep, "package.json"))) visit(dep);
  }
};
visit(process.argv[1]);
for (const dir of seen) console.log(dir);
' "$1"
}

for tree in apps/gateway apps/browser packages/*; do
  [ -d "$tree/src" ] || continue

  # Writes: this tree's own tests. Fabricating env for a package you merely
  # import is still this tree's fiction.
  writes=""
  while IFS= read -r f; do
    is_test_file "$f" || continue
    w=$(grep -hoE 'process\.env\.SEMIONT_[A-Z_]+ *(\?\?)?=[^=]' "$f" 2>/dev/null \
      | grep -oE 'SEMIONT_[A-Z_]+' || true)
    writes=$(printf '%s\n%s' "$writes" "$w")
  done < <(find "$tree/src" -name '*.ts' 2>/dev/null)
  writes=$(echo "$writes" | grep -v '^$' | sort -u || true)
  [ -n "$writes" ] || continue

  reads=""
  while IFS= read -r dir; do
    reads=$(printf '%s\n%s' "$reads" "$(package_reads "$dir")")
  done < <(dep_closure "$tree")
  reads=$(echo "$reads" | grep -v '^$' | sort -u || true)

  for var in $writes; do
    if ! echo "$reads" | grep -qxF "$var"; then
      echo "❌ H1: $tree tests export \$$var but no production code in that process reads it — delete the export with the requirement it once served:"
      grep -rlnE "process\.env\.$var *(\?\?)?=" "$tree/src" 2>/dev/null \
        | while IFS= read -r f; do is_test_file "$f" && echo "     $f"; done
      FAIL=1
    fi
  done
done

if [ "$FAIL" -eq 0 ]; then
  echo "✅ test-env hygiene clean (H1: every SEMIONT_* var a test exports is read by production code in the same process)"
fi
exit "$FAIL"
