#!/bin/sh
# neo4j-image.sh — the neo4j every check of a graph store against a real
# server runs, printed: the image the launcher starts for the graph role, from
# its row of apps/launcher/internal/launcher/descriptors.go.
#
# A store is verified against the database an operator gets. The launcher's
# descriptor names that database once, so whatever starts one for a test asks
# here: the "Python Graph Stores (neo4j)", "Weaver Conformance" and "Librarian
# Conformance" jobs of ci.yml, and a developer who starts a container for any
# of those suites.
#
# With no such row it prints nothing and fails, so a check that cannot name
# its database stops. It is plain sh: an image with no bash can run it.
set -eu
cd "$(dirname "$0")/../.."

image=$(sed -n 's/^.*role: "graph", driver: "neo4j",.* image: "\(neo4j:[^"]*\)".*$/\1/p' apps/launcher/internal/launcher/descriptors.go)
if [ -z "$image" ]; then
  echo "neo4j-image.sh: apps/launcher/internal/launcher/descriptors.go has no graph row with driver \"neo4j\" and an image \"neo4j:…\"" >&2
  exit 1
fi
echo "$image"
