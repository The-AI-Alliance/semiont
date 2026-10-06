#!/bin/sh
# check-document-image.sh <service> <image> [runtime] — what the image of a
# Rust service that only reads a configuration document promises (the
# dispatcher's, the Archivist's), checked against a built image:
#
#   1. No source: nothing that is Rust or TypeScript source, a Cargo file, a
#      build tree, node_modules or the spec (the spec is inside the binary).
#   2. No Node: the image runs a binary, and carries no runtime to run anything else.
#   3. Run as the image says, with no document mounted where its CMD tells it
#      to read one, it refuses promptly and by name — exit 1, naming the
#      document it cannot read — rather than waiting on a broker or a gateway.
#      Prompt is START_BOUND_MS, from spawning its command to its exit,
#      measured inside the container.
#
# Run by local-build.sh after it builds such an image, and by the image
# publish workflow before it pushes.
set -eu

SERVICE="${1:?usage: check-document-image.sh <service> <image> [runtime]}"
IMAGE="${2:?usage: check-document-image.sh <service> <image> [runtime]}"
RT="${3:-docker}"
DOCKERFILE="$(cd "$(dirname "$0")/../.." && pwd)/apps/$SERVICE/Dockerfile"
COMMAND=$(sed -n 's/^CMD \[\(.*\)\]$/\1/p' "$DOCKERFILE" | sed 's/", "/ /g; s/"//g')
if [ -z "$COMMAND" ]; then
  echo "✗ $DOCKERFILE declares no exec-form CMD"
  exit 1
fi

# The gateway image's start bound (check-gateway-image.sh): a refusal reads
# one file and exits, and takes no longer than a start.
START_BOUND_MS=300

# As root: the promise covers the whole image, including what the image's own
# user cannot read (as that user, find stops at /root).
found=$("$RT" run --rm --user 0 --entrypoint /bin/sh "$IMAGE" -c '
  find / \( -path /proc -o -path /sys -o -path /dev \) -prune -o \
    \( -name "*.rs" -o -name "Cargo.toml" -o -name "Cargo.lock" -o -name "*.ts" -o -name "*.js" -o -name "*.mjs" -o -name "*.cjs" \
       -o -name node -o \( -type d \( -name target -o -name node_modules -o -name specs \) \) \) -print')
if [ -n "$found" ]; then
  echo "✗ $IMAGE carries source, build output or Node:"
  echo "$found" | head -20
  exit 1
fi
echo "✓ $IMAGE carries no source and no Node"

# The script runs, and expands, inside the container: the command's output,
# then a last line of its exit status and how long it ran.
# shellcheck disable=SC2016
out=$("$RT" run --rm --entrypoint /bin/sh -e COMMAND="$COMMAND" "$IMAGE" -c '
  read spawned _ < /proc/uptime
  # shellcheck disable=SC2086
  /usr/local/bin/boot.sh $COMMAND 2>&1
  status=$?
  read exited _ < /proc/uptime
  awk -v from="$spawned" -v to="$exited" -v status="$status" "BEGIN { printf \"\\n%d %d\", status, (to - from) * 1000 }"')
log=$(echo "$out" | sed '$d')
last=$(echo "$out" | tail -1)
status=${last% *}
ms=${last#* }
if [ "$status" != 1 ]; then
  echo "✗ $IMAGE with no document exited $status, not 1:"
  echo "$log"
  exit 1
fi
if ! echo "$log" | grep -qF "Cannot read the $SERVICE's configuration document"; then
  echo "✗ $IMAGE with no document did not refuse by name:"
  echo "$log"
  exit 1
fi
echo "✓ $IMAGE with no document refuses by name: $(echo "$log" | head -1)"
if [ "$ms" -gt "$START_BOUND_MS" ]; then
  echo "✗ $IMAGE refused ${ms} ms after its command started; the bound is ${START_BOUND_MS} ms"
  exit 1
fi
echo "✓ $IMAGE refused ${ms} ms after its command started (bound ${START_BOUND_MS} ms)"
