#!/usr/bin/env bash
set -euo pipefail

# Audit: storageUri has ONE home — Representation, never ResourceDescriptor
# (STORAGE-URI-ONE-HOME P1).
#
# Why the compiler cannot be this census: the generated raw ResourceDescriptor
# ends in `& {[key: string]: unknown}` (additionalProperties: true), so a
# revived descriptor-level read like `if (resource.storageUri)` TYPECHECKS —
# as `unknown` — and is simply always absent at runtime. String-typed uses
# error; truthiness-only uses survive silently. This gate is the census the
# type system cannot run.
#
# Check 1 (exact): the field must not reappear in ResourceDescriptor.json —
# the schema is the source of truth, and keeping the field dead there is what
# makes every other regression read undefined.
# Check 2 (heuristic): no descriptor-shaped receiver dereferences .storageUri.
# The receiver names cover every shape the P1 sweep found; a novel alias can
# evade grep, but with check 1 holding it reads undefined and its own tests
# catch it.
#
# Descriptor-holding code reads the URI via getStorageUri() (@semiont/core),
# which reads the primary representation.
#
# Scope: all TS/TSX source in packages/ and apps/, tests included (fixtures
# pinning the dead shape were exactly where P1 found stragglers).
# Allowlist: SortableResourceTab.tsx — its `resource` is the browser's local
# open-resource entry (client state fed via addOpenResource), not a
# ResourceDescriptor.
# Exit code: 0 if clean, 1 if violations found.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

FAIL=0

if grep -q '"storageUri"' specs/src/components/schemas/ResourceDescriptor.json; then
  echo "❌ ONE-HOME: storageUri is back in ResourceDescriptor.json — its one home is Representation.json (STORAGE-URI-ONE-HOME D1)"
  FAIL=1
fi

VIOLATIONS=$(grep -rnE '((^|[^.A-Za-z0-9_$])(resource|descriptor|sourceDoc|targetDoc|sourceResource|loaded)|\.(resource|sourceResource|sourceDoc|targetDoc))[?!]?\.storageUri' \
  packages apps \
  --include='*.ts' --include='*.tsx' \
  2>/dev/null \
  | grep -vE "/node_modules/|/dist/|/coverage/" \
  | grep -v "packages/react-ui/src/components/navigation/SortableResourceTab.tsx" \
  || true)

if [ -n "$VIOLATIONS" ]; then
  echo "❌ ONE-HOME: descriptor-level .storageUri access — the field lives on the Representation; read it with getStorageUri() from @semiont/core:"
  echo ""
  echo "$VIOLATIONS"
  echo ""
  echo "ResourceDescriptor has no storageUri (its index signature types the access as unknown,"
  echo "so this compiles and reads undefined forever). If the receiver is genuinely not a"
  echo "ResourceDescriptor, rename it or extend this script's allowlist with the why."
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "✅ ONE-HOME: storageUri lives only on Representation; no descriptor-level access"
exit 0
