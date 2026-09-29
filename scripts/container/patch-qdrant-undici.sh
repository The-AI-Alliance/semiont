#!/bin/sh
# patch-qdrant-undici.sh [root] — replace the undici that @qdrant/js-client-rest
# pins for itself with a patched release, inside an image's installed tree.
#
# @qdrant/js-client-rest 1.19.0 pins undici at exactly 7.29.0, which carries
# CVE-2026-84961 (TLS certificate validation bypass) and CVE-2026-19534
# (denial of service via an unrequested WebSocket subprotocol) — both HIGH,
# both fixed in 7.29.1. The monorepo overrides that pin in package.json, but
# the images install @semiont/make-meaning with `npm install -g`, which
# ignores `overrides`: the pinned copy nests under qdrant and fails the image
# Trivy gate. So the image replaces it here, after install.
#
# SELF-RETIRING: this exits non-zero when there is nothing left to patch —
# qdrant nests no undici of its own, or the one it nests is already fixed.
# When that happens, DELETE this script and its RUN line in each Dockerfile;
# do not loosen the check. Absence fails on purpose: a patch step that
# silently no-ops once its package is gone is how a dead CVE patch outlives
# its reason.
#
# Run in the installer stage, after `npm install -g`, while npm is present.
set -eu

ROOT="${1:-/usr/local/lib/node_modules}"
FIXED='^7.29.1'

fixed() {
  node -e 'const [a,b,c]=process.argv[1].split(".").map(Number);
           process.exit(a>7 || (a===7 && (b>29 || (b===29 && c>=1))) ? 0 : 1)' "$1"
}
version() { node -p "require('$1/package.json').version"; }

NESTED=$(find "$ROOT" -type d -path '*/@qdrant/js-client-rest/node_modules/undici')
if [ -z "$NESTED" ]; then
  echo "✗ @qdrant/js-client-rest nests no undici of its own under $ROOT."
  echo "  Nothing to patch: DELETE scripts/container/patch-qdrant-undici.sh and its RUN line in each Dockerfile."
  exit 1
fi
for d in $NESTED; do
  if fixed "$(version "$d")"; then
    echo "✗ $d is already undici $(version "$d") (>= 7.29.1)."
    echo "  Nothing to patch: DELETE scripts/container/patch-qdrant-undici.sh and its RUN line in each Dockerfile."
    exit 1
  fi
done

TMP=$(mktemp -d)
npm pack "undici@$FIXED" --pack-destination "$TMP" --loglevel=error >/dev/null
set -- "$TMP"/undici-*.tgz
tar -xzf "$1" -C "$TMP"
# A directory swap is only a complete install for a package with no
# dependencies of its own; undici has none. Refuse rather than half-install.
if node -e 'const p=require(process.argv[1]); process.exit(Object.keys(p.dependencies||{}).length ? 0 : 1)' "$TMP/package/package.json"; then
  echo "✗ undici $(version "$TMP/package") declares dependencies; a directory swap would not install them."
  exit 1
fi

for d in $NESTED; do
  was=$(version "$d")
  rm -rf "$d" && cp -a "$TMP/package" "$d"
  now=$(version "$d")
  fixed "$now" || { echo "✗ $d is still undici $now after patching"; exit 1; }
  echo "✓ ${d#"$ROOT"/}: undici $was -> $now"
done
rm -rf "$TMP"
