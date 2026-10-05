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

# Which systems the launcher is built for, and each one's archive format, are
# goreleaser's to decide. A list restated here went stale when the release
# gained Windows zips, and the release still verified without them.
GORELEASER="$ROOT/apps/launcher/.goreleaser.yaml"
yaml_list() {
  awk -v key="$1" '
    $0 ~ "^[[:space:]]*" key ":[[:space:]]*$" { on = 1; next }
    on && /^[[:space:]]*-[[:space:]]/ { sub(/^[[:space:]]*-[[:space:]]*/, ""); print; next }
    on { exit }' "$GORELEASER"
}
GOOS_LIST=$(yaml_list goos)
GOARCH_LIST=$(yaml_list goarch)
# "default <format>", then "<goos> <format>" for each override.
ARCHIVE_FORMATS=$(awk '
  function first(line) { sub(/^[^[]*\[[[:space:]]*/, "", line); sub(/[],[:space:]].*$/, "", line); return line }
  /^archives:/ { archives = 1; next }
  archives && /^[a-z]/ { exit }
  archives && /format_overrides:/ { overrides = 1; next }
  archives && !overrides && /formats:/ { print "default", first($0) }
  overrides && /goos:/ { os = $NF }
  overrides && /formats:/ { print os, first($0) }' "$GORELEASER")
archive_format() {
  local f
  f=$(awk -v os="$1" '$1 == os { print $2 }' <<< "$ARCHIVE_FORMATS")
  [ -n "$f" ] || f=$(awk '$1 == "default" { print $2 }' <<< "$ARCHIVE_FORMATS")
  echo "$f"
}

PROBES=""        # one archive of each format, to download and hash below
BREW_ASSETS=0    # Homebrew runs on macOS and Linux; the formula offers those
if [ -z "$GOOS_LIST" ] || [ -z "$GOARCH_LIST" ] || [ -z "$(archive_format default)" ]; then
  bad "could not read goos, goarch and the archive formats from ${GORELEASER#"$ROOT"/}"
else
  probed=" "
  for os in $GOOS_LIST; do
    fmt=$(archive_format "$os")
    for arch in $GOARCH_LIST; do
      archive="semiont_${VERSION}_${os}_${arch}.${fmt}"
      for n in "$archive" "$archive.sbom.json"; do
        has_asset "$n" && ok "$n" || bad "$n missing"
      done
      case "$probed" in *" $fmt "*) ;; *) probed="$probed$fmt "; PROBES="$PROBES $archive" ;; esac
      case "$os" in darwin|linux) BREW_ASSETS=$((BREW_ASSETS+1)) ;; esac
    done
  done
fi
has_asset checksums.txt && ok "checksums.txt" || bad "checksums.txt missing"

# The checksums file is goreleaser's own output, so agreeing with it only proves
# internal consistency. Hashing a downloaded tarball is what proves the bytes
# people install match what was signed and listed.
if has_asset checksums.txt; then
  gh release download "v$VERSION" -R "$REPO" -p checksums.txt -D "$WORK" --clobber >/dev/null 2>&1
  for probe in $PROBES; do
    if gh release download "v$VERSION" -R "$REPO" -p "$probe" -D "$WORK" --clobber >/dev/null 2>&1; then
      want=$(awk -v f="$probe" '$2==f || $2=="*"f {print $1}' "$WORK/checksums.txt")
      got=$(shasum -a 256 "$WORK/$probe" | cut -d' ' -f1)
      [ -n "$want" ] && [ "$want" = "$got" ] \
        && ok "$probe sha256 matches checksums.txt (${got:0:16}…)" \
        || bad "$probe sha256 mismatch: listed=${want:-none} actual=$got"
    else
      bad "could not download $probe to hash it"
    fi
  done
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
  [ "$urls" -eq "$BREW_ASSETS" ] && ok "formula references $urls v$VERSION assets" || bad "formula references $urls v$VERSION assets, expected $BREW_ASSETS"
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

# "Indexed" and "installable" are different claims. The packument lists a
# version minutes before the CDN will serve its tarball. Checking only
# `.versions[$v]` here would report a release verified while `npm install`
# fails on a 404 for the tarball. One fetch answers both:
# the tarball URL comes out of the same document, and a HEAD settles it.
for pkg in $npm_names; do
  enc=${pkg//\//%2f}
  doc=$(curl -sf "https://registry.npmjs.org/$enc")
  if [ -z "$doc" ]; then
    bad "$pkg — registry unreachable or package does not exist"
    continue
  fi
  tarball=$(printf '%s' "$doc" | jq -r --arg v "$VERSION" '.versions[$v].dist.tarball // empty')
  if [ -z "$tarball" ]; then
    latest=$(printf '%s' "$doc" | jq -r '."dist-tags".latest // "unreachable"')
    bad "$pkg@$VERSION not in registry (latest=$latest)"
  elif curl -sfI "$tarball" >/dev/null; then
    ok "$pkg@$VERSION"
  else
    bad "$pkg@$VERSION is indexed but its tarball does not serve — not installable"
  fi
done

# ----------------------------------------------------------------------- crates
head_ "Rust crates"

# Each crate is asked of crates.io twice, as the npm packages are: the index
# says the version exists, and the .crate it names is downloaded and hashed
# against the checksum the index states.
CRATES_IO_AGENT='semiont-verify-release (https://github.com/The-AI-Alliance/semiont)'
CRATES=$("$ROOT/scripts/release/published-crates.sh")
[ -n "$CRATES" ] || bad "published-crates.sh named no crate"
for crate in $CRATES; do
  meta=$(curl -sf -A "$CRATES_IO_AGENT" "https://crates.io/api/v1/crates/$crate/$VERSION")
  if [ -z "$meta" ]; then
    latest=$(curl -sf -A "$CRATES_IO_AGENT" "https://crates.io/api/v1/crates/$crate" | jq -r '.crate.max_version // empty')
    bad "$crate $VERSION not on crates.io (latest=${latest:-none})"
    continue
  fi
  if [ "$(jq -r .version.yanked <<< "$meta")" != "false" ]; then
    bad "$crate $VERSION is yanked"
    continue
  fi
  want=$(jq -r .version.checksum <<< "$meta")
  if curl -sfL -A "$CRATES_IO_AGENT" -o "$WORK/$crate.crate" "https://crates.io/api/v1/crates/$crate/$VERSION/download"; then
    got=$(shasum -a 256 "$WORK/$crate.crate" | cut -d' ' -f1)
    [ "$want" = "$got" ] \
      && ok "$crate $VERSION downloads, sha256 matches the index (${got:0:16}…)" \
      || bad "$crate $VERSION sha256 mismatch: index=$want downloaded=$got"
  else
    bad "$crate $VERSION is on the index but its .crate does not download"
  fi
done

# ---------------------------------------------------------------------- images
head_ "Container images"

# The matrix in the publish workflow decides which services get images; the
# Dockerfiles on disk decide which ones can. Disagreement means a service is
# building nothing or is missing from the release, so treat it as a failure
# rather than picking one list and hoping.
# `sort -u`: a service whose architectures build on separate runners has one
# matrix row per architecture, so it appears twice.
# The question here is which services get images, not how many legs build them.
matrix_services=$(grep -oE '^\s+- service: [a-z]+' "$ROOT/.github/workflows/publish-service-images.yml" | awk '{print $3}' | sort -u)
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
