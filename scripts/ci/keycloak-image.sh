#!/bin/sh
# keycloak-image.sh — the Keycloak every check of the launcher against a real
# issuer runs, printed: the image the launcher starts for the identity role,
# from its row of packages/go/launcher/descriptors.go.
#
# A realm is verified against the Keycloak an operator gets. The launcher's
# descriptor names that Keycloak once, so whatever starts one for a test asks
# here: the "Launcher Tests (Go, Keycloak)" job of ci.yml, and a developer who
# starts a container for the launcher's live tests.
#
# With no such row it prints nothing and fails, so a check that cannot name
# its issuer stops. It is plain sh: an image with no bash can run it.
set -eu
cd "$(dirname "$0")/../.."

image=$(sed -n 's/^.*role: "identity", driver: "keycloak",.* image: "\(quay.io\/keycloak\/keycloak:[^"]*\)".*$/\1/p' packages/go/launcher/descriptors.go)
if [ -z "$image" ]; then
  echo "keycloak-image.sh: packages/go/launcher/descriptors.go has no identity row with driver \"keycloak\" and an image \"quay.io/keycloak/keycloak:…\"" >&2
  exit 1
fi
echo "$image"
