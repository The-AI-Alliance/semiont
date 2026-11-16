#!/usr/bin/env bash
set -euo pipefail

# Verify that every published @semiont/* package's dist resolves cleanly
# under `tsc --moduleResolution NodeNext` against a synthetic consumer
# project. Catches the asymmetric-dist regression class — bundled .js
# with per-file .d.ts shards (or any other dist incoherence) — *before*
# the tarballs reach a downstream NodeNext consumer.
#
# Background: see `.plans/CLEANUP-SDK.md` item 1. tsup emits bundled
# `dist/index.js`; tsc with `emitDeclarationOnly` used to emit sharded
# `dist/*.d.ts` next to it. Under NodeNext, `dist/index.d.ts`'s internal
# re-exports (`export * from './client'`) failed because the matching
# `./client.js` didn't exist. We now bundle `.d.ts` via
# `rollup-plugin-dts` so the dist contains only one .d.ts per entry
# point — this gate proves that contract holds.
#
# How the check works:
#   1. For every `packages/<name>` listed in version.json:
#      a. `npm pack` → tarball
#      b. Extract to a scratch dir
#      c. Drop a synthetic `smoke.ts` that does `import * as p from "@semiont/<name>"`
#      d. Run `tsc --noEmit` with `moduleResolution: NodeNext`
#   2. Any non-zero tsc exit fails the gate.
#
# Usage:
#   ./scripts/ci/verify-nodenext-resolution.sh
#
# Assumes packages have already been built (run after `./scripts/ci/build.sh`).
# Runs inside the host shell; uses the host's `node`/`npm`/`npx` (the
# whole point is to mimic an external consumer).

cd "$(dirname "$0")/../.."

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

step() { echo -e "${CYAN}▸${RESET} $1"; }
ok()   { echo -e "${GREEN}✓${RESET} $1"; }
fail() { echo -e "${RED}✗${RESET} $1"; }

# Workspace TS for the consumer typecheck. Pin to whatever the workspace
# uses so we exercise the resolver the workspace publishes against.
TS_VERSION=$(node -e "console.log(require('./package.json').devDependencies.typescript || 'latest')" | sed 's/^\^//')

# Packages to verify. Each line is "<full-name>\t<dir>" so we don't have
# to reconstruct paths. Read from version.json so adding a new package
# auto-includes it in the gate.
PACKAGES=$(node -e "
const v = require('./version.json');
for (const [name, pkg] of Object.entries(v.packages || {})) {
  if (pkg.dir && pkg.dir.startsWith('packages/') && pkg.publish !== false) {
    console.log(name + '\t' + pkg.dir);
  }
}
")

SCRATCH=$(mktemp -d -t semiont-nodenext-XXXXXX)
trap "rm -rf '$SCRATCH'" EXIT

step "Scratch dir: ${DIM}$SCRATCH${RESET}"
step "TypeScript:  ${DIM}$TS_VERSION${RESET}"

# Install TS once for all checks
(cd "$SCRATCH" && npm init -y > /dev/null && npm install --silent --no-package-lock "typescript@$TS_VERSION")

FAILED=()

while IFS=$'\t' read -r pkg_name pkg_dir; do
  [ -z "$pkg_name" ] && continue
  short_name="${pkg_name#@semiont/}"  # bare name for scratch dir

  if [ ! -d "$pkg_dir/dist" ]; then
    fail "$pkg_name: no dist/ — run build first"
    FAILED+=("$pkg_name")
    continue
  fi

  step "Verifying $pkg_name…"

  # Pack the built package
  tarball_path=$(cd "$pkg_dir" && npm pack --silent 2>/dev/null | tail -1)
  if [ -z "$tarball_path" ] || [ ! -f "$pkg_dir/$tarball_path" ]; then
    fail "$pkg_name: npm pack produced no tarball"
    FAILED+=("$pkg_name")
    continue
  fi

  # Each package gets its own scratch consumer so installs don't conflict
  consumer="$SCRATCH/$short_name"
  mkdir -p "$consumer"
  cp "$pkg_dir/$tarball_path" "$consumer/pkg.tgz"
  rm "$pkg_dir/$tarball_path"

  cat > "$consumer/package.json" <<EOF
{
  "name": "verify-$short_name",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "$pkg_name": "file:./pkg.tgz"
  }
}
EOF

  cat > "$consumer/tsconfig.json" <<EOF
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": []
  },
  "include": ["smoke.ts"]
}
EOF

  cat > "$consumer/smoke.ts" <<EOF
// Verify $pkg_name's type surface resolves cleanly under NodeNext.
// \`import *\` forces the resolver to walk the full re-export chain
// in the package's index.d.ts; any missing matching .js (the
// asymmetric-dist class of bug) fails here.
import * as pkg from '$pkg_name';
void pkg;
EOF

  # Install the tarball into the consumer. Use --no-package-lock since
  # we're in a throwaway scratch dir.
  if ! (cd "$consumer" && npm install --silent --no-package-lock 2>&1 | tail -3 > install.log); then
    fail "$pkg_name: npm install failed"
    cat "$consumer/install.log"
    FAILED+=("$pkg_name")
    continue
  fi

  # Symlink in the shared node_modules/typescript so the consumer can
  # find tsc without re-installing it.
  ln -sfn "$SCRATCH/node_modules/typescript" "$consumer/node_modules/typescript"

  if (cd "$consumer" && ./node_modules/typescript/bin/tsc --noEmit) 2> "$consumer/tsc.log"; then
    ok "$pkg_name resolves cleanly under NodeNext"
  else
    fail "$pkg_name: NodeNext typecheck FAILED"
    cat "$consumer/tsc.log"
    FAILED+=("$pkg_name")
  fi
done <<< "$PACKAGES"

if [ ${#FAILED[@]} -gt 0 ]; then
  echo
  fail "NodeNext verification failed for: ${FAILED[*]}"
  echo
  echo "Most common cause: the package's dist has per-file .d.ts shards"
  echo "without matching .js files. The .d.ts bundle step in"
  echo "rollup.dts.config.mjs may not be running, or a new entry point"
  echo "needs to be added to the package's rollup config."
  exit 1
fi

echo
ok "All @semiont/* packages resolve cleanly under NodeNext."
