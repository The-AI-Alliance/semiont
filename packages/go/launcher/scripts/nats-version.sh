#!/bin/sh
# nats-version.sh — the version of the NATS broker, printed: the one
# packages/go/launcher/go.mod requires of github.com/nats-io/nats-server/v2,
# without its "v".
#
# The launcher's libraries require that module for their tests, which read
# the broker's config with the parser of the image the launcher runs, and a
# test holds the image's tag to the module. Dependabot moves the line. What cannot read a
# go.mod asks here, so the line is read in one place and one way:
# .github/scripts/install-nats-server.sh, which fetches the broker a CI job runs its
# suite against.
#
# lint:nats-version refuses a second copy of the version, and a second reader
# of the line.
#
# With no such line it prints nothing and fails, so a job that cannot name its
# broker stops. It is plain sh: an image with no bash can run it.
set -eu
cd "$(dirname "$0")/../../../.."

version=$(sed -n 's/^[[:space:]]*github\.com\/nats-io\/nats-server\/v2 v\([0-9][0-9.]*\)$/\1/p' packages/go/launcher/go.mod)
if [ -z "$version" ]; then
  echo "nats-version.sh: packages/go/launcher/go.mod has no 'github.com/nats-io/nats-server/v2 vX.Y.Z' line" >&2
  exit 1
fi
echo "$version"
