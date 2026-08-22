#!/usr/bin/env bash
set -euo pipefail

# Audit the graph annotation codec's two axioms.
#
# `packages/graph` has four store implementations. They used to carry four
# near-verbatim copies of the annotation↔properties shape, which drifted:
# a missing selector threw in neo4j, became `{}` in janusgraph and neptune;
# a missing motivation threw in neo4j and silently became `'linking'` in the
# other two. One event log, four different annotations. The `{}` reached the
# wire and 400'd the wizard's Search leg.
#
# A1 — exactly one module decides that shape. No W3C envelope is built inside
#      an implementation file.
# A5 — the codec manufactures nothing. No `|| '{}'`, no `|| 'linking'`, no
#      optional-with-fallback: absence must fail loudly, never acquire a
#      value the next reader cannot tell from a real one.
#
# See .plans/GRAPH-ANNOTATION-CODEC.md.

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
  echo "   Build it in annotation-codec.ts (buildAnnotation/decodeAnnotation) instead."
  echo "$envelope" | sed 's|^|   |'
  violations=$((violations + 1))
fi

# The selector's serialization is the codec's too — this is the exact
# expression that minted the `'{}'` rows, in four places.
if minted=$(grep -rn "JSON\.stringify([^)]*|| *{}" "$IMPLEMENTATIONS" 2>/dev/null); then
  echo ""
  echo "❌ A1: an implementation is serializing a selector with a manufactured default."
  echo "$minted" | sed 's|^|   |'
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

if [ "$violations" -eq 0 ]; then
  echo "✅ A1: no W3C envelope built outside the codec"
  echo "✅ A5: the codec manufactures nothing"
  exit 0
fi

echo ""
echo "Found $violations violation(s). See .plans/GRAPH-ANNOTATION-CODEC.md."
exit 1
