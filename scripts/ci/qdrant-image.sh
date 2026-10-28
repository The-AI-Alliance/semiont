#!/bin/sh
# qdrant-image.sh — the Qdrant every check of a Smelter against a real vector
# database runs, printed: the image the launcher starts for the vectors role,
# from its row of packages/go/launcher/descriptors.go.
#
# An index is verified in the database an operator gets. The launcher's
# descriptor names that database once, so whatever starts one for a test asks
# here: the "Smelter Conformance", "Librarian Conformance" and "Python Vector
# Stores (Qdrant)" jobs of ci.yml, and a developer who starts a container for
# any of them.
#
# With no such row it prints nothing and fails, so a check that cannot name
# its database stops. It is plain sh: an image with no bash can run it.
set -eu
cd "$(dirname "$0")/../.."

image=$(sed -n 's/^.*role: "vectors", driver: "qdrant",.* image: "\(qdrant\/qdrant:[^"]*\)".*$/\1/p' packages/go/launcher/descriptors.go)
if [ -z "$image" ]; then
  echo "qdrant-image.sh: packages/go/launcher/descriptors.go has no vectors row with driver \"qdrant\" and an image \"qdrant/qdrant:…\"" >&2
  exit 1
fi
echo "$image"
