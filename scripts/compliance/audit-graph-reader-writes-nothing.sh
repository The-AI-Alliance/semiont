#!/usr/bin/env bash
set -euo pipefail

# No store of @semiont/graph writes to its database.
#
# The graph has one writer: the Weaver, a Python service that writes through
# semiont_graph (packages/graph-python). @semiont/graph is what a reader of
# the graph reads it with. Its interface has no member that changes the graph,
# and audit-graph-interface-callers.sh holds every member to a caller.
#
# That leaves what a store does unasked. The neo4j store made constraints and
# indexes each time it connected, and answered what the vocabulary is by
# writing the default entity types into it first: a suite that read the graph
# through it wrote to the graph it was reading.
#
# So no file under packages/graph/src/implementations says a Cypher clause
# that writes (CREATE, MERGE, SET, DELETE, REMOVE, DROP) or a Gremlin step
# that does (addV, addE, property, drop). A word in a comment is not code. The
# database's schema is its writer's to make.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMPLEMENTATIONS="$REPO_ROOT/packages/graph/src/implementations"

echo "🔍 Auditing that the graph's readers write nothing..."

if [ ! -d "$IMPLEMENTATIONS" ]; then
  echo "❌ $IMPLEMENTATIONS not found — the stores are what this audit reads."
  exit 1
fi

# The lines of the stores that match a pattern, less the ones that are
# comments. grep answers 1 for none found. Anything else is grep itself
# failing, and a search that could not run has found nothing out: the audit
# stops and says so, rather than report the stores clean.
lines_saying() {
  local status=0 found
  found=$(grep -rnE "$1" "$IMPLEMENTATIONS" 2>&1) || status=$?
  if [ "$status" -gt 1 ]; then
    echo "❌ the search of the stores could not run (grep exited $status):" >&2
    printf '%s\n' "$found" | sed 's|^|   |' >&2
    exit 2
  fi
  printf '%s\n' "$found" | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|/\*|\*)' || true
}

violations=0

cypher=$(lines_saying '(^|[^A-Za-z_])(CREATE|MERGE|SET|DELETE|REMOVE|DROP)([^A-Za-z_]|$)')
if [ -n "$cypher" ]; then
  echo ""
  echo "❌ a store says a Cypher clause that writes:"
  printf '%s\n' "$cypher" | sed 's|^|   |'
  violations=$((violations + 1))
fi

gremlin=$(lines_saying '\.(addV|addE|property|drop)\(')
if [ -n "$gremlin" ]; then
  echo ""
  echo "❌ a store calls a Gremlin step that writes:"
  printf '%s\n' "$gremlin" | sed 's|^|   |'
  violations=$((violations + 1))
fi

if [ "$violations" -eq 0 ]; then
  echo "✅ no store of @semiont/graph writes to its database: no schema, no node, no edge, no property"
  exit 0
fi

echo ""
echo "   The graph's one writer is the Weaver (apps/weaver), through semiont_graph (packages/graph-python)."
echo "   A reader that needs something written asks nothing of the database: the record is where a change is made."
echo ""
echo "Found $violations violation(s)."
exit 1
