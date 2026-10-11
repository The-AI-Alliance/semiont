#!/usr/bin/env bash
set -euo pipefail

# Every member of `GraphDatabase` has a caller, or is kept by name.
#
# The interface is written once for every store behind it: a member costs one
# method in each of four TypeScript stores, and one again in each Python store
# that follows them. Nine members once had no caller in any service. They were
# not idle: none had ever run against a database, and when three were, two
# answered wrongly (a count read from a property no store writes, a path
# sought along an edge that joins no two resources). A member nobody calls is
# held by nobody.
#
# So a member is called from the services' source, or it is named below with
# the word that keeps it. The list is held to the tree both ways: a kept
# member that has gained a caller comes off it, and a name that is no longer a
# member is refused.
#
# A caller is a call in non-test TypeScript under apps/ or packages/, outside
# the stores themselves (packages/graph/src/implementations). The factory is a
# caller. A store calling its own method is not: that is how a member comes to
# look alive while no service reaches it.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INTERFACE="$REPO_ROOT/packages/graph/src/interface.ts"

# Kept with no caller, by the user's ruling of 2026-10-11 on what the
# Librarian's port will need: "`resolveReference` certainly sounds like it
# should be ported. Probably those other two." All three are members of the
# Python stores (semiont_graph), which is where a port will call them.
# `resolveReference` is a write: it went from this interface with every other
# write when the Weaver became the Python service, since nothing here writes
# the graph. The other two are reads, and are kept here until the Librarian
# is Python.
KEPT=(findPath getStats)

echo "🔍 Auditing the graph interface's callers..."

if [ ! -f "$INTERFACE" ]; then
  echo "❌ $INTERFACE not found — the interface is what this audit reads."
  exit 1
fi

members=$(awk '
  /^export interface GraphDatabase \{/ { inside = 1; next }
  inside && /^\}/ { inside = 0 }
  inside && match($0, /^  [A-Za-z]+\(/) { print substr($0, RSTART + 2, RLENGTH - 3) }
' "$INTERFACE")

if [ -z "$members" ]; then
  echo "❌ no member of GraphDatabase could be read from $INTERFACE."
  exit 1
fi

# grep answers 0 for a caller found and 1 for none. Anything else is grep
# itself failing (BusyBox's takes none of these options), and a search that
# could not run has found nothing out: the audit stops and says so, rather
# than report every member as uncalled.
has_caller() {
  local status=0
  grep -rnE "\.$1\(" "$REPO_ROOT/apps" "$REPO_ROOT/packages" \
    --include='*.ts' --include='*.tsx' \
    --exclude='*.test.ts' --exclude='*.test.tsx' --exclude='*.live.ts' --exclude='*.d.ts' \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=dist-types \
    --exclude-dir=coverage --exclude-dir=__tests__ --exclude-dir=implementations \
    > /dev/null 2> "$GREP_ERRORS" || status=$?
  if [ "$status" -gt 1 ]; then
    echo "❌ the search for callers of $1 could not run (grep exited $status). This audit needs GNU grep:"
    sed 's|^|   |' "$GREP_ERRORS"
    exit 2
  fi
  return "$status"
}

is_kept() {
  local name
  for name in "${KEPT[@]}"; do
    [ "$name" = "$1" ] && return 0
  done
  return 1
}

GREP_ERRORS="$(mktemp)"
trap 'rm -f "$GREP_ERRORS"' EXIT

violations=0
count=0

for member in $members; do
  count=$((count + 1))
  if has_caller "$member"; then
    if is_kept "$member"; then
      echo "❌ $member is kept as a member with no caller, and it has one now. Take it off the kept list."
      violations=$((violations + 1))
    fi
  elif ! is_kept "$member"; then
    echo "❌ $member has no caller in any service. Delete it from the interface and the stores, or give it a caller."
    violations=$((violations + 1))
  fi
done

for name in "${KEPT[@]}"; do
  if ! printf '%s\n' "$members" | grep -qx "$name"; then
    echo "❌ $name is on the kept list and is not a member of GraphDatabase."
    violations=$((violations + 1))
  fi
done

if [ "$violations" -eq 0 ]; then
  echo "✅ all $count members of GraphDatabase have a caller, or are kept by name (${KEPT[*]})"
  exit 0
fi

echo ""
echo "Found $violations violation(s)."
exit 1
