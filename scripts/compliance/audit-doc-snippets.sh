#!/usr/bin/env bash
set -euo pipefail

# Audit: every ```ts/```tsx/```typescript fence in packages/sdk/docs/*.md
# type-checks against the BUILT packages, resolved through the exports map the
# way an external consumer resolves them (SAFE-DOCS). Doc rot fails CI instead
# of waiting for a reader to paste a dead snippet.
#
# What green does NOT claim (do not oversell it):
#   - Shape, not meaning: a method whose semantics changed under a stable
#     signature still slips through — behavioral truth stays with the contract
#     suites (CACHE-SEMANTICS B-numbers, liveness axioms).
#   - `tsc` alone cannot see thenable-era rot (`await` on a non-thenable is
#     legal TS); the checker's await-thenable walk covers that class.
#   - Fences marked `no-check` are exempt (genuine pseudocode / display-only
#     shapes); the run prints the exemption census — hold it flat or shrink it.
#
# POST-BUILD gate: requires dist for core/http-transport/sdk/react-ui and an
# installed workspace tree (the fixture at packages/sdk/docs/__snippets__).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="$REPO_ROOT/packages/sdk/docs/__snippets__"

for pkg in core http-transport sdk react-ui; do
  if [ ! -f "$REPO_ROOT/packages/$pkg/dist/index.d.ts" ]; then
    echo "❌ doc-snippets: packages/$pkg/dist is missing — run 'npm run build:packages' first (this is a post-build gate)."
    exit 1
  fi
done
if [ ! -d "$REPO_ROOT/node_modules/@semiont/sdk" ]; then
  echo "❌ doc-snippets: workspace links missing — run 'npm install' first."
  exit 1
fi

echo "📚 Checking sdk doc snippets compile against dist (exports-map resolution)..."
node "$FIXTURE/check.mjs"
