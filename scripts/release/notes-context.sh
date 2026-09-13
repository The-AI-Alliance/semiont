#!/usr/bin/env bash
# Assemble everything needed to write a release post, so nothing is written from
# commit subjects alone.
#
#   scripts/release/notes-context.sh [previous-tag]     # defaults to latest release
#
# Writes a single file and prints its path. Read that file, then write the post.
# It carries every merged PR's FULL body — not titles, not a sample — plus the
# planning docs touched in the same window, because the origin story and the
# measurements that make a post worth reading live there and nowhere else.

set -uo pipefail

REPO=The-AI-Alliance/semiont
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# The window is "what produced the version in version.json", so the previous tag
# is the newest release that is NOT that version. Taking the newest release
# outright breaks the moment the tag is cut — which is exactly when these notes
# get written — and yields an empty window rather than an error.
CURRENT=$(gh api "repos/$REPO/contents/version.json" --jq .content | base64 -d | jq -r .version)
PREV="${1:-$(gh release list -R "$REPO" --limit 10 --json tagName \
             --jq "[.[] | select(.tagName != \"v$CURRENT\")] | .[0].tagName")}"
[ -n "$PREV" ] && [ "$PREV" != "null" ] || { echo "cannot determine previous tag" >&2; exit 2; }

TAG_SHA=$(gh api "repos/$REPO/git/ref/tags/${PREV#refs/tags/}" --jq .object.sha 2>/dev/null)
SINCE=$(gh api "repos/$REPO/commits/$TAG_SHA" --jq .commit.committer.date 2>/dev/null)
[ -n "$SINCE" ] || { echo "cannot date $PREV" >&2; exit 2; }

OUT="$ROOT/.release-notes-context.md"
NEXT="$CURRENT"

{
  echo "# Release-notes context: $PREV -> $NEXT"
  echo
  echo "Window opens $SINCE (the $PREV tag)."
  echo

  echo "## Merged PRs"
  echo
} > "$OUT"

# The skill drops dependabot from the post; this lists them separately rather
# than filtering silently, so a security bump that mattered can still be seen.
# The previous tag sits ON the merge commit of that release's last PR, and that
# PR's mergedAt lands a hair after the commit's own timestamp — so a purely
# time-based window re-reports the previous release's final PR every time.
# Excluding the tagged commit by sha closes it exactly, with no timestamp fudge.
PRS=$(gh pr list -R "$REPO" --state merged --limit 100 \
        --json number,title,author,mergedAt,url,body,files,mergeCommit \
        --jq "[.[] | select(.mergedAt > \"$SINCE\") | select(.mergeCommit.oid != \"$TAG_SHA\")] | sort_by(.number)")

# Headings inside a PR body are demoted so they cannot be mistaken for this
# document's own sections when skimming.
echo "$PRS" | jq -r '
  def noise: (.author.login | test("dependabot"))
          or (.title | test("^[a-z-]+\\(deps(-dev)?\\):"))
          or (.title | test("^bump version to "));
  [ .[] | select(noise) ] as $bots
  | [ .[] | select(noise | not) ] as $real
  | ($real[] | "### PR #\(.number) — \(.title)\n_by \(.author.login), merged \(.mergedAt)_\n\nFiles: \([.files[].path] | length) changed\n\n\((.body // "_(no body)_") | gsub("(?m)^#"; "#####"))\n\n---\n")
  , "\n## Dependency and bump PRs (excluded from the post body)\n"
  , ($bots[] | "- #\(.number) \(.title)")
' >> "$OUT" 2>/dev/null

{
  echo
  echo "## Planning docs touched in this window"
  echo
  echo "**A plan appearing here is NOT evidence its work shipped.** These are matched by"
  echo "modification time only, so the list includes plans that were written, revised, or"
  echo "abandoned in this window without being executed. The merged PRs above are the"
  echo "evidence of what shipped; a plan supplies the *why* behind work that already"
  echo "appears there. Never write a release-note claim whose only source is a plan."
  echo
} >> "$OUT"

if [ -d "$ROOT/.plans" ]; then
  # BSD find cannot parse an ISO8601 timestamp: `-newermt 2026-09-10T02:56:55Z`
  # fails with "Can't parse date/time", and silencing that error turns nine
  # modified plans into a confident "none". Convert the timestamp once and
  # compare against a marker file, which every find accepts.
  MARKER="$(mktemp)"
  STAMP=$(date -ju -f '%Y-%m-%dT%H:%M:%SZ' "$SINCE" '+%Y%m%d%H%M.%S' 2>/dev/null \
          || date -u -d "$SINCE" '+%Y%m%d%H%M.%S' 2>/dev/null)
  if [ -z "$STAMP" ]; then
    echo "cannot convert $SINCE for this platform's find" >&2
    rm -f "$MARKER"; exit 2
  fi
  touch -t "$STAMP" "$MARKER"

  # No 2>/dev/null here: a broken scan must be visible, not read as an empty one.
  PLANS=$(find "$ROOT/.plans" -name '*.md' -newer "$MARKER" | sort)
  rc=$?
  rm -f "$MARKER"
  if [ "$rc" -ne 0 ]; then
    echo "scanning .plans failed (find exit $rc)" >&2
    exit 2
  fi

  if [ -n "$PLANS" ]; then
    while IFS= read -r f; do
      printf -- '- %s  (modified %s)\n' "${f#"$ROOT"/}" "$(date -r "$f" '+%Y-%m-%d %H:%M')"
    done <<< "$PLANS" >> "$OUT"
  else
    echo "_none modified since ${SINCE}_" >> "$OUT"
  fi
else
  echo "_no .plans directory_" >> "$OUT"
fi

{
  echo
  echo "## Checklist before writing"
  echo
  echo "- [ ] Read every PR body above, not a sample. A template-only body means go to the plan."
  echo "- [ ] Read the planning docs behind the substantial PRs."
  echo "- [ ] Bullets stay one line each; depth goes in \`## Theme\` sections below the release link."
  echo "- [ ] No \`.plans/\` paths anywhere in the post — reviewers cannot see untracked files."
} >> "$OUT"

n_real=$(echo "$PRS" | jq "[.[] | select(((.author.login | test(\"dependabot\")) or (.title | test(\"^[a-z-]+\\\\(deps(-dev)?\\\\):\")) or (.title | test(\"^bump version to \"))) | not)] | length")
n_bot=$(echo "$PRS" | jq "[.[] | select((.author.login | test(\"dependabot\")) or (.title | test(\"^[a-z-]+\\\\(deps(-dev)?\\\\):\")) or (.title | test(\"^bump version to \")))] | length")
echo "$n_real substantive PRs, $n_bot dependency PRs, window from $PREV"
echo "$OUT"
