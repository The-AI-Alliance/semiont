#!/usr/bin/env bash
# Lint a release post against the conventions, and post it on --post.
#
#   scripts/release/announce.sh 0.5.34 draft.md            # lint only
#   scripts/release/announce.sh 0.5.34 draft.md --post     # lint, then publish
#
# The file's first line is the discussion title; everything after it is the body.
# Lint always runs first, and a blocking failure prevents posting. The rules are
# the ones that have actually been broken: `.plans/` paths leaking into a post
# where no reader can resolve them, and bullets swelling into paragraphs once the
# whitepaper sections were dropped.

set -uo pipefail

REPO=The-AI-Alliance/semiont
CATEGORY_NAME=General
VERSION="${1:-}"; FILE="${2:-}"; MODE="${3:-}"
[ -n "$VERSION" ] && [ -f "$FILE" ] || { echo "usage: $0 <version> <file.md> [--post]" >&2; exit 2; }

# Blocking checks are the objectively-wrong ones: a link that resolves nowhere, a
# title the reader cannot parse, a path no reader can open. Style calls warn but
# do not block — a deliberately substantive bullet is a legitimate choice, and a
# gate that overrules the author on taste just gets bypassed.
FAIL=0; WARN=0
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$1"; WARN=$((WARN+1)); }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; }

LINK="Release: https://github.com/$REPO/releases/tag/v$VERSION"
printf '\nLinting %s against v%s\n\n' "$FILE" "$VERSION"

grep -qxF "$LINK" "$FILE" && ok "release link present and correct" \
  || bad "missing the exact release link line: $LINK"

grep -q '\.plans' "$FILE" \
  && bad "post references .plans/ — reviewers cannot see untracked files" \
  || ok "no .plans references"

grep -nE '🎉|🚀|✨|🔥|💥' "$FILE" >/dev/null \
  && bad "post contains emoji" || ok "no emoji"

grep -niE '\b(exciting|awesome|huge|game[- ]chang|revolutionary|blazing)\b' "$FILE" >/dev/null \
  && bad "post contains hype language" || ok "no hype language"

# Everything above the release link is the tight half. A bullet that grew past a
# line means depth went into the bullets instead of into a section below.
LINKLINE=$(grep -nxF "$LINK" "$FILE" | head -1 | cut -d: -f1)
if [ -n "$LINKLINE" ]; then
  long=$(head -n "$LINKLINE" "$FILE" | awk 'length > 200 && /^[-*] /{print NR": "length" chars"}')
  if [ -n "$long" ]; then
    while read -r l; do warn "bullet above the release link is long — $l"; done <<< "$long"
  else
    ok "bullets above the release link stay tight"
  fi

  above=$(head -n "$LINKLINE" "$FILE" | grep -c '^## ')
  [ "$above" -eq 0 ] && ok "no ## sections above the release link" \
    || warn "$above '## ' section(s) above the release link — depth belongs below it"

  below=$(tail -n +"$LINKLINE" "$FILE" | grep -c '^## ')
  bullets=$(head -n "$LINKLINE" "$FILE" | grep -c '^[-*] ')
  if [ "$bullets" -ge 5 ] && [ "$below" -eq 0 ]; then
    warn "$bullets bullets and no '## ' sections — a release this deep usually carries a whitepaper section"
  else
    ok "$bullets bullets, $below whitepaper section(s)"
  fi
fi

TITLE=$(head -1 "$FILE" | sed 's/^# *//')
case "$TITLE" in
  v*) bad "title starts with 'v' — use the bare version" ;;
  *" -- "*) ok "title uses the ' -- ' separator" ;;
  *) bad "title is not '<version> -- <theme>': $TITLE" ;;
esac
case "$TITLE" in "$VERSION"*) ok "title starts with $VERSION" ;; *) bad "title does not start with $VERSION" ;; esac

printf '\n'
if [ "$FAIL" -ne 0 ]; then printf '\033[31m%d blocking failure(s) — not posting.\033[0m\n' "$FAIL"; exit 1; fi
[ "$WARN" -eq 0 ] && printf '\033[32mLint clean.\033[0m\n' \
                  || printf '\033[33m%d style warning(s) — review, then post if intended.\033[0m\n' "$WARN"

[ "$MODE" = "--post" ] || { echo "Dry run. Re-run with --post to publish."; exit 0; }

REPO_ID=$(gh api "repos/$REPO" --jq .node_id)
CAT_ID=$(gh api graphql -f query="{repository(owner:\"${REPO%/*}\",name:\"${REPO#*/}\"){discussionCategories(first:20){nodes{id name}}}}" \
         --jq ".data.repository.discussionCategories.nodes[] | select(.name==\"$CATEGORY_NAME\") | .id")
[ -n "$CAT_ID" ] || { echo "cannot resolve the $CATEGORY_NAME category" >&2; exit 1; }

# The first line is the title; the body is everything after it.
BODY_FILE=$(mktemp); trap 'rm -f "$BODY_FILE"' EXIT
tail -n +2 "$FILE" | sed '/./,$!d' > "$BODY_FILE"

gh api graphql -F body=@"$BODY_FILE" -f repoId="$REPO_ID" -f catId="$CAT_ID" -f title="$TITLE" -f query='
  mutation($repoId:ID!,$catId:ID!,$title:String!,$body:String!){
    createDiscussion(input:{repositoryId:$repoId,categoryId:$catId,title:$title,body:$body}){
      discussion { number url }
    }
  }' --jq '.data.createDiscussion.discussion | "posted #\(.number)  \(.url)"'
