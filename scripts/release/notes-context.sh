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

PREV="${1:-$(gh release list -R "$REPO" --limit 1 --json tagName --jq '.[0].tagName')}"
[ -n "$PREV" ] || { echo "cannot determine previous tag" >&2; exit 2; }

SINCE=$(gh api "repos/$REPO/git/ref/tags/${PREV#refs/tags/}" --jq .object.sha 2>/dev/null \
        | xargs -I{} gh api "repos/$REPO/commits/{}" --jq .commit.committer.date 2>/dev/null)
[ -n "$SINCE" ] || { echo "cannot date $PREV" >&2; exit 2; }

OUT="$ROOT/.release-notes-context.md"
NEXT=$(gh api "repos/$REPO/contents/version.json" --jq .content | base64 -d | jq -r .version)

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
PRS=$(gh pr list -R "$REPO" --state merged --limit 100 \
        --json number,title,author,mergedAt,url,body,files \
        --jq "[.[] | select(.mergedAt > \"$SINCE\")] | sort_by(.number)")

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
  echo "_Untracked, so matched by modification time. Read the ones behind the big PRs —"
  echo "their Date / Origin / Status headers usually carry the whole story._"
  echo
} >> "$OUT"

if [ -d "$ROOT/.plans" ]; then
  found=0
  while IFS= read -r f; do
    found=1
    printf -- '- %s  (modified %s)\n' "${f#"$ROOT"/}" "$(date -r "$f" '+%Y-%m-%d %H:%M')"
  done < <(find "$ROOT/.plans" -name '*.md' -newermt "$SINCE" 2>/dev/null | sort) >> "$OUT"
  [ "$found" -eq 1 ] || echo "_none modified since ${SINCE}_" >> "$OUT"
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
