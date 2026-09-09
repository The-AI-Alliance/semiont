#!/usr/bin/env bash
# Verify a published release across every channel, by inspecting the artifacts
# themselves rather than trusting workflow conclusions.
#
#   scripts/release/verify-release.sh 0.5.33
#
# Exits non-zero listing every channel that failed. Run it after the publish
# workflows finish and before announcing the release.
#
# The mutable-tag checks resolve :latest to a digest and compare it against both
# the released version and the previous one, so "never moved" is distinguishable
# from "moved somewhere unexpected". A tag existing proves nothing.

set -uo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: $0 <version>   e.g. $0 0.5.33" >&2
  exit 2
fi

REPO=The-AI-Alliance/semiont
TAP=The-AI-Alliance/homebrew-semiont
OWNER=The-AI-Alliance
GHCR=ghcr.io/the-ai-alliance
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ghcr allows anonymous pulls of public packages; no PAT needed to read manifests.
ghcr_token() { curl -sf "https://ghcr.io/token?scope=repository:the-ai-alliance/$1:pull" | jq -r .token; }
ghcr_digest() {
  curl -sfI -H "Authorization: Bearer $2" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
    "https://ghcr.io/v2/the-ai-alliance/$1/manifests/$3" \
    | tr -d '\r' | awk 'tolower($1)=="docker-content-digest:"{print $2}'
}

# ---------------------------------------------------------------- tag & release
head_ "Tag and GitHub Release"

TAG_SHA=$(git ls-remote "https://github.com/$REPO" "refs/tags/v$VERSION" | cut -f1)
if [ -n "$TAG_SHA" ]; then ok "tag v$VERSION on origin (${TAG_SHA:0:8})"
else bad "tag v$VERSION missing on origin"; fi

REL="$WORK/release.json"
if gh release view "v$VERSION" -R "$REPO" --json isDraft,isPrerelease,assets > "$REL" 2>/dev/null; then
  [ "$(jq -r .isDraft "$REL")" = "false" ] && ok "release published (not draft)" || bad "release is a draft"
  [ "$(jq -r .isPrerelease "$REL")" = "false" ] && ok "release not marked prerelease" || bad "release marked prerelease"
else
  bad "release v$VERSION not found"; echo '{"assets":[]}' > "$REL"
fi
has_asset() { jq -e --arg n "$1" '.assets[] | select(.name==$n)' "$REL" >/dev/null 2>&1; }

# --------------------------------------------------------------------- launcher
head_ "Launcher binaries"

for plat in darwin_amd64 darwin_arm64 linux_amd64 linux_arm64; do
  for suffix in .tar.gz .tar.gz.sbom.json; do
    n="semiont_${VERSION}_${plat}${suffix}"
    has_asset "$n" && ok "$n" || bad "$n missing"
  done
done
has_asset checksums.txt && ok "checksums.txt" || bad "checksums.txt missing"

# The checksums file is goreleaser's own output, so agreeing with it only proves
# internal consistency. Hashing a downloaded tarball is what proves the bytes
# people install match what was signed and listed.
if has_asset checksums.txt; then
  gh release download "v$VERSION" -R "$REPO" -p checksums.txt -D "$WORK" --clobber >/dev/null 2>&1
  probe="semiont_${VERSION}_darwin_arm64.tar.gz"
  if gh release download "v$VERSION" -R "$REPO" -p "$probe" -D "$WORK" --clobber >/dev/null 2>&1; then
    want=$(awk -v f="$probe" '$2==f || $2=="*"f {print $1}' "$WORK/checksums.txt")
    got=$(shasum -a 256 "$WORK/$probe" | cut -d' ' -f1)
    [ -n "$want" ] && [ "$want" = "$got" ] \
      && ok "$probe sha256 matches checksums.txt (${got:0:16}…)" \
      || bad "$probe sha256 mismatch: listed=${want:-none} actual=$got"
  else
    bad "could not download $probe to hash it"
  fi
fi

# ------------------------------------------------------------------- homebrew
head_ "Homebrew tap"

FORMULA="$WORK/semiont.rb"
if gh api "repos/$TAP/contents/Formula/semiont.rb" --jq .content 2>/dev/null | base64 -d > "$FORMULA"; then
  grep -q "version \"$VERSION\"" "$FORMULA" \
    && ok "formula at $VERSION" || bad "formula not at $VERSION (got: $(grep -m1 'version "' "$FORMULA" | tr -d ' '))"
  # Every url the formula offers must point at this release, or `brew install`
  # silently serves an older build on some architectures.
  urls=$(grep -c "download/v$VERSION/" "$FORMULA")
  [ "$urls" -eq 4 ] && ok "formula references 4 v$VERSION assets" || bad "formula references $urls v$VERSION assets, expected 4"
else
  bad "could not read tap formula"
fi

# ------------------------------------------------------------------------- npm
head_ "npm packages"

# version.json owns which packages publish; the app entries carry their real npm
# identity in package.publish.json, since the in-tree package.json is private
# and unscoped. Derive both — never restate the list here.
npm_names=$(jq -r '.packages | to_entries[] | select(.value.publish) | "\(.key)\t\(.value.dir)"' "$ROOT/version.json" \
  | while IFS=$'\t' read -r key dir; do
      if [ -f "$ROOT/$dir/package.publish.json" ]; then jq -r .name "$ROOT/$dir/package.publish.json"
      else echo "$key"; fi
    done)

for pkg in $npm_names; do
  enc=${pkg//\//%2f}
  if curl -sf "https://registry.npmjs.org/$enc" | jq -e --arg v "$VERSION" '.versions[$v]' >/dev/null 2>&1; then
    ok "$pkg@$VERSION"
  else
    latest=$(curl -sf "https://registry.npmjs.org/$enc" | jq -r '."dist-tags".latest // "unreachable"')
    bad "$pkg@$VERSION not in registry (latest=$latest)"
  fi
done

# ---------------------------------------------------------------------- images
head_ "Container images"

# The matrix in the publish workflow decides which services get images; the
# Dockerfiles on disk decide which ones can. Disagreement means a service is
# building nothing or is missing from the release, so treat it as a failure
# rather than picking one list and hoping.
matrix_services=$(grep -oE '^\s+- service: [a-z]+' "$ROOT/.github/workflows/publish-service-images.yml" | awk '{print $3}' | sort)
dockerfile_apps=$(ls -d "$ROOT"/apps/*/Dockerfile 2>/dev/null | awk -F/ '{print $(NF-1)}' | grep -v '^browser$' | sort)
if [ "$matrix_services" = "$dockerfile_apps" ]; then
  ok "service matrix matches apps/*/Dockerfile ($(echo "$matrix_services" | tr '\n' ' '))"
else
  bad "service matrix and apps/*/Dockerfile disagree — matrix:[$(echo "$matrix_services" | tr '\n' ' ')] dockerfiles:[$(echo "$dockerfile_apps" | tr '\n' ' ')]"
fi

PREV=$(git -C "$ROOT" tag -l 'v*' --sort=-v:refname 2>/dev/null | grep -v "^v$VERSION$" | head -1 | sed 's/^v//')

for svc in $matrix_services browser; do
  img="semiont-$svc"
  tok=$(ghcr_token "$img")
  if [ -z "$tok" ] || [ "$tok" = "null" ]; then bad "$img: no registry token"; continue; fi

  idx=$(curl -sf -H "Authorization: Bearer $tok" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
    "https://ghcr.io/v2/the-ai-alliance/$img/manifests/$VERSION")
  if [ -z "$idx" ]; then bad "$img:$VERSION not published"; continue; fi

  plats=$(echo "$idx" | jq -r '[.manifests[]? | select(.platform.architecture != "unknown") | .platform.architecture] | sort | join(",")')
  atts=$(echo "$idx" | jq -r '[.manifests[]? | select(.platform.architecture == "unknown")] | length')
  [ "$plats" = "amd64,arm64" ] && ok "$img:$VERSION platforms=$plats" || bad "$img:$VERSION platforms=$plats, expected amd64,arm64"
  [ "${atts:-0}" -ge 1 ] && ok "$img:$VERSION has $atts attestation manifest(s)" || bad "$img:$VERSION has no attestation manifest"

  # The check that a workflow conclusion cannot give you: where :latest points.
  d_ver=$(ghcr_digest "$img" "$tok" "$VERSION")
  d_lat=$(ghcr_digest "$img" "$tok" latest)
  if [ "$d_lat" = "$d_ver" ]; then
    ok "$img:latest == :$VERSION (${d_ver:0:20}…)"
  elif [ -n "$PREV" ] && [ "$d_lat" = "$(ghcr_digest "$img" "$tok" "$PREV")" ]; then
    bad "$img:latest is STALE at $PREV — dispatch with --field tag_latest=true, or retag the index"
  else
    bad "$img:latest resolves to ${d_lat:-nothing}, which is neither :$VERSION nor :$PREV"
  fi

  if gh attestation verify "oci://$GHCR/$img:$VERSION" --owner "$OWNER" --format json > "$WORK/att.json" 2>/dev/null; then
    subj=$(jq -r '.[0].verificationResult.statement.subject[0].digest.sha256' "$WORK/att.json")
    [ "sha256:$subj" = "$d_ver" ] \
      && ok "$img:$VERSION provenance verified, subject matches tag" \
      || bad "$img:$VERSION provenance subject sha256:${subj:0:16}… != tag digest ${d_ver:0:23}…"
  else
    bad "$img:$VERSION provenance did not verify"
  fi
done

# ------------------------------------------------------------------- discussion
head_ "Release announcement"

if gh api graphql -f q="repo:$REPO $VERSION" -f query='query($q:String!){search(query:$q,type:DISCUSSION,first:5){nodes{... on Discussion{title url}}}}' \
     --jq '.data.search.nodes[].title' 2>/dev/null | grep -q "$VERSION"; then
  ok "discussion mentioning $VERSION exists"
else
  bad "no release discussion found for $VERSION"
fi

# ----------------------------------------------------------------------- result
printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
