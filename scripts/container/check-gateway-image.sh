#!/bin/sh
# check-gateway-image.sh <image> [runtime] — what the gateway image promises
# (RUST-GATEWAY D9), checked against a built image:
#
#   1. No source: nothing that is Rust or TypeScript source, a Cargo file, a
#      build tree, node_modules or the spec (the spec is inside the binary).
#   2. It starts quickly: from spawning the image's command to its first
#      /api/health 200, inside the container, under START_BOUND_MS. The same
#      span the conformance harness records; the runtime's own start is not in it.
#      Its document is mounted where the image says the gateway reads it (the
#      path its CMD passes to --config), as the launcher mounts it.
#   3. Its HEALTHCHECK passes against the serving gateway: the command
#      apps/gateway/Dockerfile declares, read from there rather than restated,
#      so this check cannot probe an address the healthcheck does not.
#
# Run by local-build.sh after it builds the gateway image, and by the image
# publish workflow before it pushes.
set -eu

IMAGE="${1:?usage: check-gateway-image.sh <image> [runtime]}"
RT="${2:-docker}"
DOCKERFILE="$(cd "$(dirname "$0")/../.." && pwd)/apps/gateway/Dockerfile"
HEALTHCHECK=$(sed -n '/^HEALTHCHECK/,/CMD /s/^.*CMD //p' "$DOCKERFILE")
if [ -z "$HEALTHCHECK" ]; then
  echo "✗ $DOCKERFILE declares no HEALTHCHECK CMD"
  exit 1
fi
DOCUMENT=$(sed -n 's/^CMD \[.*"--config", "\([^"]*\)".*$/\1/p' "$DOCKERFILE")
if [ -z "$DOCUMENT" ]; then
  echo "✗ $DOCKERFILE's CMD passes no --config"
  exit 1
fi

# Set from the start times measured before the cutover (RUST-GATEWAY P1): the
# Rust gateway served within 68 ms of spawning, the TypeScript one within
# 649 ms (367 ms median). Four times the Rust gateway's slowest, and under
# the TypeScript gateway's median.
START_BOUND_MS=300

# As root: the promise covers the whole image, including what the image's own
# user cannot read (as that user, find stops at /root).
found=$("$RT" run --rm --user 0 --entrypoint /bin/sh "$IMAGE" -c '
  find / \( -path /proc -o -path /sys -o -path /dev \) -prune -o \
    \( -name "*.rs" -o -name "Cargo.toml" -o -name "Cargo.lock" -o -name "*.ts" -o -name "*.js" -o -name "*.mjs" -o -name "*.cjs" \
       -o \( -type d \( -name target -o -name node_modules -o -name specs \) \) \) -print')
if [ -n "$found" ]; then
  echo "✗ $IMAGE carries source or build output:"
  echo "$found" | head -20
  exit 1
fi
echo "✓ $IMAGE carries no source"

# A document for one gateway on its own plane. Its issuer and Archivist are
# never dialled before the first request that needs them, so none is running.
# Written on the host and readable by the image's user, whatever uid that is.
STAGE=$(mktemp -d /tmp/gateway-image-check.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT
cat > "$STAGE/gateway.json" <<DOC
{"kb":{"name":"Image check","domain":"image-check.example"},"port":4000,"publicUrl":"http://localhost:4000",
 "identity":{"issuer":"http://127.0.0.1:1","subjectClaim":"sub"},"archivist":{"host":"127.0.0.1","port":1},
 "signal":{"type":"in-process"},"logLevel":"warn","logFormat":"json",
 "capacity":{"queuedBytes":1073741824,"connections":52428}}
DOC
chmod 0755 "$STAGE"
chmod 0644 "$STAGE/gateway.json"

# The script runs, and expands, inside the container.
# shellcheck disable=SC2016
set +e
ms=$("$RT" run --rm --entrypoint /bin/sh \
  -v "$STAGE/gateway.json:$DOCUMENT:ro" \
  -e JWT_SECRET=image-check-image-check-image-check-image-check \
  -e SEMIONT_OIDC_CLIENT_ID=semiont-gateway \
  -e SEMIONT_OIDC_CLIENT_SECRET=image-check \
  -e HEALTHCHECK="$HEALTHCHECK" \
  -e DOCUMENT="$DOCUMENT" \
  "$IMAGE" -c '
  read spawned _ < /proc/uptime
  /usr/local/bin/boot.sh /usr/local/bin/semiont-gateway --config "$DOCUMENT" >/tmp/gateway.log 2>&1 &
  tries=0
  until wget -q -O /dev/null http://127.0.0.1:4000/api/health 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -gt 200 ]; then cat /tmp/gateway.log >&2; exit 3; fi
    sleep 0.05
  done
  read served _ < /proc/uptime
  sh -c "$HEALTHCHECK" >&2 || exit 4
  awk -v from="$spawned" -v to="$served" "BEGIN { printf \"%d\", (to - from) * 1000 }"')
status=$?
set -e
case $status in
  0) ;;
  4)
    echo "✗ $IMAGE serves /api/health, but its HEALTHCHECK fails: $HEALTHCHECK"
    exit 1
    ;;
  *)
    echo "✗ $IMAGE did not serve /api/health within 10 s"
    exit 1
    ;;
esac
echo "✓ $IMAGE passes its HEALTHCHECK: $HEALTHCHECK"
if [ "$ms" -gt "$START_BOUND_MS" ]; then
  echo "✗ $IMAGE served /api/health ${ms} ms after its command started; the bound is ${START_BOUND_MS} ms"
  exit 1
fi
echo "✓ $IMAGE served /api/health ${ms} ms after its command started (bound ${START_BOUND_MS} ms)"
