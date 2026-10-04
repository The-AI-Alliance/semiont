#!/usr/bin/env bash
set -euo pipefail

# Audit: every ```ts/```tsx/```typescript fence in the documented packages
# type-checks against the BUILT packages, resolved through the exports map the
# way that doc's reader resolves them (SAFE-DOCS). Doc rot fails CI instead of
# waiting for a reader to paste a dead snippet. Three suites:
#   - sdk:    docs/builder, docs/protocol and docs/protocol/flows, plus the repo-root and packages/sdk READMEs.
#   - skills: the agent skills, docs/builder/skills/*/SKILL.md, and their README.
#   - ui:     docs/builder/react-ui, packages/react-ui/docs and apps/browser/docs plus their READMEs.
#
# What green does NOT claim (do not oversell it):
#   - Shape, not meaning: a method whose semantics changed under a stable
#     signature still slips through — behavioral truth stays with the contract
#     suites (CACHE-SEMANTICS B-numbers, liveness axioms).
#   - `tsc` alone cannot see thenable-era rot (`await` on a non-thenable is
#     legal TS); the checker's await-thenable walk covers that class.
#   - Fences marked `sketch` are exempt (genuine pseudocode / display-only
#     shapes); the run prints the exemption census — hold it flat or shrink it.
#
# POST-BUILD gate: requires dist for core/http-transport/sdk/jobs/react-ui/make-meaning and an
# installed workspace tree (the fixture at tests/doc-snippets).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="$REPO_ROOT/tests/doc-snippets"

for pkg in core http-transport sdk jobs react-ui make-meaning; do
  if [ ! -f "$REPO_ROOT/packages/$pkg/dist/index.d.ts" ]; then
    echo "❌ doc-snippets: packages/$pkg/dist is missing — run 'npm run build:packages' first (this is a post-build gate)."
    exit 1
  fi
done
if [ ! -d "$REPO_ROOT/node_modules/@semiont/sdk" ]; then
  echo "❌ doc-snippets: workspace links missing — run 'npm install' first."
  exit 1
fi

echo "📚 Checking doc snippets compile against dist (exports-map resolution)..."
node "$FIXTURE/check.mjs"
