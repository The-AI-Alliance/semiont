#!/bin/sh
# install-nats-server.sh — put the NATS broker on PATH, for a CI job whose
# suite runs against a real one: the nats-server release of the version the
# launcher requires (packages/go/launcher/scripts/nats-version.sh), into /usr/local/bin.
#
# Each conformance job of .github/workflows/ci.yml runs it before its suite.
# This is the one place a release is fetched, and lint:nats-version refuses
# another.
#
# A release is built for one system and one processor, so the machine is asked
# which it is, and one this names no release for is refused before anything is
# fetched. It is plain sh: an image with no bash can run it.
set -eu
cd "$(dirname "$0")/../.."

version="v$(packages/go/launcher/scripts/nats-version.sh)"
case "$(uname -s) $(uname -m)" in
  "Linux x86_64") platform=linux-amd64 ;;
  "Linux aarch64") platform=linux-arm64 ;;
  *)
    echo "install-nats-server.sh: no nats-server release is named here for $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac
release="nats-server-${version}-${platform}"

unpacked=$(mktemp -d)
trap 'rm -rf "$unpacked"' EXIT
curl -fsSL "https://github.com/nats-io/nats-server/releases/download/${version}/${release}.tar.gz" | tar xz -C "$unpacked"

# /usr/local/bin is root's: a runner's user asks, and root does not need to.
if [ "$(id -u)" -eq 0 ]; then
  mv "$unpacked/${release}/nats-server" /usr/local/bin/
else
  sudo mv "$unpacked/${release}/nats-server" /usr/local/bin/
fi
nats-server --version
