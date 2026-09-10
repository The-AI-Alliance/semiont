#!/usr/bin/env bash
# Decide whether main is releasable, and print the command that releases it.
#
#   scripts/release/preflight.sh
#
# Every check runs against what origin/main actually holds, read over the wire —
# never the local working tree, which can be ahead, behind, or dirty with another
# session's work. Exits non-zero if anything would make the release wrong.

set -uo pipefail

REPO=The-AI-Alliance/semiont
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }

# ls-remote reads the remote without fetching, so this is accurate even when the
# local clone is stale and leaves the working tree untouched.
SHA=$(git ls-remote "https://github.com/$REPO" refs/heads/main | cut -f1)
[ -n "$SHA" ] || { echo "cannot read origin/main"; exit 2; }
printf '\norigin/main is \033[1m%s\033[0m\n\n' "${SHA:0:8}"

# ---------------------------------------------------------- version consistency
gh api "repos/$REPO/contents/version.json?ref=$SHA" --jq .content 2>/dev/null | base64 -d > "$WORK/version.json"
VERSION=$(jq -r .version "$WORK/version.json" 2>/dev/null)
if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
  echo "cannot read version.json at $SHA"; exit 2
fi
ok "version.json at origin/main says $VERSION"

# release.yml fails the tag job on a mismatch. Catching it here costs seconds
# instead of a dispatched run that dies after tagging nothing.
mismatch=0
while read -r path; do
  v=$(gh api "repos/$REPO/contents/$path?ref=$SHA" --jq .content 2>/dev/null | base64 -d | jq -r .version)
  [ "$v" = "$VERSION" ] || { bad "$path is at $v, expected $VERSION"; mismatch=1; }
done < <(cd "$ROOT" && git ls-tree -r --name-only "origin/main" 2>/dev/null | grep -E '^(packages|apps)/[^/]+/package\.json$' \
         || ls -d "$ROOT"/packages/*/package.json "$ROOT"/apps/*/package.json | sed "s|$ROOT/||")
[ "$mismatch" -eq 0 ] && ok "all package.json files at $VERSION"

# ------------------------------------------------------------------ tag is free
if git ls-remote "https://github.com/$REPO" "refs/tags/v$VERSION" | grep -q .; then
  bad "tag v$VERSION already exists on origin — bump before releasing"
else
  ok "tag v$VERSION is free"
fi

# ------------------------------------------------------------------- CI on HEAD
# `gh run list --limit 1` returns whatever run the API surfaces first, which is
# routinely NOT the newest and has reported a phantom head more than once. Ask
# for this commit's own check runs instead.
gh api "repos/$REPO/commits/$SHA/check-runs?per_page=100" --jq '.check_runs[] | "\(.conclusion // .status)\t\(.name)"' > "$WORK/checks.txt" 2>/dev/null

if [ ! -s "$WORK/checks.txt" ]; then
  bad "no check runs reported for $SHA — CI may not have started"
else
  total=$(wc -l < "$WORK/checks.txt" | tr -d ' ')
  failed=$(awk -F'\t' '$1!="success" && $1!="skipped" && $1!="neutral"' "$WORK/checks.txt")
  if [ -z "$failed" ]; then
    ok "all $total check runs on $SHA are green"
  else
    while IFS=$'\t' read -r st name; do bad "check '$name' is $st"; done <<< "$failed"
  fi
fi

# --------------------------------------------------- previous release published
PREV=$(gh release list -R "$REPO" --limit 1 --json tagName --jq '.[0].tagName' 2>/dev/null | sed 's/^v//')
if [ -n "$PREV" ]; then
  ok "previous release is $PREV (verify it with: scripts/release/verify-release.sh $PREV)"
fi

# ---------------------------------------------------------------------- verdict
printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
  printf '\n\033[31mNot releasable.\033[0m Fix the above first.\n'
  exit 1
fi

cat <<EOF

Releasable. One dispatch publishes every channel:

  gh workflow run release.yml

Then, once the runs finish:

  scripts/release/verify-release.sh $VERSION
EOF
