#!/usr/bin/env bash
set -euo pipefail

# Audit the graph annotation codec's two axioms.
#
# `packages/graph` has four store implementations. Four near-verbatim copies
# of the annotation↔properties shape drift: a missing selector throws in one
# and becomes `{}` in another; a missing motivation throws in one and silently
# becomes `'linking'` in another. One event log, four different annotations,
# and the `{}` reaches the wire.
#
# A1 — exactly one module decides that shape. No W3C envelope is built inside
#      an implementation file. The same holds of a resource and its codec.
# A5 — the codec manufactures nothing. No `|| '{}'`, no `|| 'linking'`, no
#      optional-with-fallback: absence must fail loudly, never acquire a
#      value the next reader cannot tell from a real one.
#
#      A5 covers what the implementations HAND the codec, not just the codec
#      body. A store that mints `new Date().toISOString()` for `created` and
#      passes it in satisfies A5's letter and breaks its spirit one call frame
#      up: the codec faithfully stores a manufactured value. Because
#      `rebuildResource` deletes before it replays, that restamps every
#      annotation on every reconcile heal.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMPLEMENTATIONS="$REPO_ROOT/packages/graph/src/implementations"
CODEC="$REPO_ROOT/packages/graph/src/annotation-codec.ts"

violations=0

echo "🔍 Auditing the graph annotation codec..."

# ---------------------------------------------------------------------------
# A1: the W3C envelope is the codec's, and only the codec's.
# ---------------------------------------------------------------------------
if envelope=$(grep -rn "anno\.jsonld" "$IMPLEMENTATIONS" 2>/dev/null); then
  echo ""
  echo "❌ A1: a W3C annotation envelope is built inside an implementation file."
  echo "   Build it in annotation-codec.ts (decodeAnnotation) instead."
  echo "$envelope" | sed 's|^|   |'
  violations=$((violations + 1))
fi

# The selector's serialization is the codec's too — this is the
# expression that mints `'{}'` rows.
if minted=$(grep -rn "JSON\.stringify([^)]*|| *{}" "$IMPLEMENTATIONS" 2>/dev/null); then
  echo ""
  echo "❌ A1: an implementation is serializing a selector with a manufactured default."
  echo "$minted" | sed 's|^|   |'
  violations=$((violations + 1))
fi

# A resource's envelope is its codec's, the same way (resource-codec.ts).
# Three stores once each built it, and each named the node's properties for
# itself: one media type was `format`, `contentType` and `mediaType`.
if envelope=$(grep -rn "schema\.org" "$IMPLEMENTATIONS" 2>/dev/null); then
  echo ""
  echo "❌ A1: a resource envelope is built inside an implementation file."
  echo "   Build it in resource-codec.ts (decodeResource) instead."
  echo "$envelope" | sed 's|^|   |'
  violations=$((violations + 1))
fi

# ---------------------------------------------------------------------------
# A5: the codec manufactures nothing.
# ---------------------------------------------------------------------------
if [ ! -f "$CODEC" ]; then
  echo "❌ A5: $CODEC not found — the codec is the single decision point; it must exist."
  exit 1
fi

if manufactured=$(grep -nE "(\|\||\?\?) *('\{\}'|\"\{\}\"|'\[\]'|'linking'|'highlighting')" "$CODEC" 2>/dev/null); then
  echo ""
  echo "❌ A5: the codec is manufacturing a value where the stored row has none."
  echo "   Absence must throw or be omitted, never default."
  echo "$manufactured" | sed 's|^|   |'
  violations=$((violations + 1))
fi

# A5, one frame up: an implementation must not mint a value the log carries
# and hand it to the codec. The event supplies `created`; a store that stamps
# its own clock overwrites the authoring moment with a write moment.
#
# No store reads a clock at all: not its own (`new Date()`, `Date.now()`), and
# not the database's (`datetime()`, `timestamp()` in a query). neo4j once
# stamped `updatedAt` on every update and `resolvedAt` on every resolve, both
# with the database's clock, as native temporals nothing read; a rebuild lost
# them, and a check that looked only for JavaScript's `new Date()` could not
# see either.
if stamped=$(grep -rnE "new Date\(|Date\.now\(|datetime\(\)|timestamp\(\)" "$IMPLEMENTATIONS" 2>/dev/null); then
  echo ""
  echo "❌ A5: an implementation is reading a clock."
  echo "   The log carries the authored value; pass it through, never stamp one."
  echo "$stamped" | sed 's|^|   |'
  violations=$((violations + 1))
fi

if [ "$violations" -eq 0 ]; then
  echo "✅ A1: no annotation or resource envelope built outside its codec"
  echo "✅ A5: the codec manufactures nothing"
  echo "✅ A5: no implementation reads a clock"
  exit 0
fi

echo ""
echo "Found $violations violation(s)."
exit 1
