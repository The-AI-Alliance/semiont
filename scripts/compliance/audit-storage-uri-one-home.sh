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
# Check 3 (heuristic): no descriptor LITERAL assigns storageUri as a sibling of
# `representations:`. Checks 1-2 caught reads and the schema, but the P2 live
# gate found a third shape they both miss — weaver.ts BUILDING a descriptor
# with the URI at the top level. It typechecked, and rebuilt the whole graph
# projection with 57 nulls.
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

# Check 3: a descriptor literal that assigns storageUri as a SIBLING of
# `representations:` is building the dead shape. Same indentation = same object
# literal, which is the cheap structural proxy for "top level of a descriptor".
CONSTRUCTIONS=$(python3 - <<'PY'
import pathlib, re

def siblings(lines, i, indent):
    """Lines in the SAME object literal as lines[i]: same indentation, walking
    out in both directions until a shallower line closes the enclosing object.
    A window-based scan instead catches unrelated literals that merely sit
    nearby at the same depth (it flagged a Representation inside a
    mockReturnValue)."""
    for rng in (range(i - 1, -1, -1), range(i + 1, len(lines))):
        for j in rng:
            l = lines[j]
            if not l.strip():
                continue
            ind = len(l) - len(l.lstrip())
            if ind < indent:
                break
            if ind == indent:
                yield j, l

def factory_hits(lines, sf):
    """Check 3b: `storageUri:` at brace depth 1 inside a descriptor factory
    call (createTestResource({...})). The override object IS a descriptor
    literal, but it usually has no `representations:` sibling for check 3 to
    anchor on — this shape escaped to CI twice (memorygraph, then the graph
    interface-contract suite). Depth 1 = top level of the override; a URI
    inside `representations: [{ ... }]` sits at depth 2+ and is the correct
    shape."""
    for i, l in enumerate(lines):
        if "createTestResource(" not in l:
            continue
        depth = 0
        started = False
        for j in range(i, min(len(lines), i + 40)):
            seg = lines[j]
            if not started:
                idx = seg.find("createTestResource(")
                seg = seg[idx + len("createTestResource("):]
                started = True
            for ch in seg:
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
            if "storageUri:" in lines[j]:
                rep_inline = "representations:" in lines[j]
                # depth AFTER the line ~ depth of its content for the
                # one-property-per-line style this codebase uses.
                if depth == 1 and not rep_inline:
                    yield j, lines[j]
            if started and depth <= 0 and j > i:
                break

hits = []
for base in ("packages", "apps"):
    for f in pathlib.Path(base).rglob("*.ts*"):
        sf = str(f)
        if any(x in sf for x in ("/node_modules/", "/dist/", "/coverage/")):
            continue
        try:
            lines = f.read_text().splitlines()
        except Exception:
            continue
        for i, l in enumerate(lines):
            if not re.match(r"\s*representations:", l):
                continue
            indent = len(l) - len(l.lstrip())
            for j, sib in siblings(lines, i, indent):
                if "storageUri" not in sib or "representations:" in sib:
                    continue
                if re.search(r"(storageUri:|\.\.\.\(.*storageUri)", sib):
                    hits.append(f"{sf}:{j+1}:{sib.strip()}")
        for j, l in factory_hits(lines, sf):
            hits.append(f"{sf}:{j+1}:{l.strip()}")
for h in sorted(set(hits)):
    print(h)
PY
) || true

if [ -n "$CONSTRUCTIONS" ]; then
  echo "❌ ONE-HOME: a descriptor literal assigns storageUri beside representations: — the URI belongs INSIDE the representation (STORAGE-URI-ONE-HOME D1):"
  echo ""
  echo "$CONSTRUCTIONS"
  echo ""
  echo "additionalProperties:true means this compiles and then reads back undefined"
  echo "through getStorageUri(). weaver.ts shipped exactly this and rebuilt the graph"
  echo "projection with 57 null URIs; only a live rebuild caught it."
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "✅ ONE-HOME: storageUri lives only on Representation; no descriptor-level access or construction"
exit 0
