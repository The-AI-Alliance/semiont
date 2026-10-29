#!/usr/bin/env bash
# published-go-modules.sh — the Go modules a release publishes, one directory a
# line. Go has no registry: a module in a subdirectory of a repository is
# published by a tag named for its directory, `<directory>/v<version>`.
#
# release.yml pushes each one's tag and asks the Go module proxy for it, and
# verify-release.sh checks what the proxy serves, so both read this one answer.
#
# The SDK alone is published. The launcher's libraries and the conformance
# drivers require it by a `replace` on its path, which a program outside this
# repository does not read, so outside it they would not resolve.
#
# Fails, naming the module, when the module's path is not this repository's
# path and the module's directory (the tag is named for the directory, and Go
# finds the module by its path), or when its go.mod has a `replace`.
set -euo pipefail
cd "$(dirname "$0")/../.."

REPOSITORY=github.com/The-AI-Alliance/semiont

for dir in packages/go/sdk; do
  module=$(awk '$1 == "module" { print $2; exit }' "$dir/go.mod")
  if [ "$module" != "$REPOSITORY/$dir" ]; then
    echo "published-go-modules.sh: $dir/go.mod is the module '$module', not $REPOSITORY/$dir" >&2
    exit 1
  fi
  if grep -qE '^replace([[:space:]]|\()' "$dir/go.mod"; then
    echo "published-go-modules.sh: $dir/go.mod has a replace directive, which a program that requires the module does not read" >&2
    exit 1
  fi
  echo "$dir"
done
