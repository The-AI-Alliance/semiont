#!/usr/bin/env bash
# Sourced by the local build session.

# --- Drift gates (FIRST: they are the most common failure, and they need only
# the repo plus a container — failing here costs seconds, not the ten minutes
# of package and image builds that follow) ---

if [[ "$IMAGES_ONLY" != true ]]; then

# --- bus registry drift gate ---
#
# specs/src/bus/registry.json is the AUTHORITY for the event bus: channels,
# payload shapes, and the request/reply operations. BOTH languages are
# generated from it — packages/typescript/core/src/bus-protocol.ts + bus-operations.ts
# (TypeScript) and packages/go/sdk/bus/*_gen.go — so an edit to one language's
# generated file, or a registry change without regeneration, is drift that
# would let the two sides disagree at runtime. Each generator's --check diffs
# without writing. The generators of this gate and of the Python and Go gates
# below are listed once, in package.json's generate:<list>:check, which CI
# runs too.

banner "DRIFT AND LOCKFILE GATES"

if ! run_logged "the bus registry and both generated languages agree" \
    $RT run --rm -v "$REPO_ROOT":/workspace -w /workspace "$NODE_IMAGE" \
    npm run generate:bus:check; then
  fail "Generated bus files are STALE (or were hand-edited) — they must match specs/src/bus/registry.json."
  echo ""
  echo -e "  Regenerate both languages and commit:"
  echo ""
  echo -e "    ${BOLD}npm run generate:bus${RESET}   (packages/typescript/core/src/bus-protocol.ts, bus-operations.ts; packages/go/sdk/bus/*_gen.go)"
  echo ""
  echo -e "  Channels and operations are edited in ${BOLD}specs/src/bus/registry.json${RESET}, never in the generated files."
  echo ""
  exit 1
fi

# --- the bundled spec ---
#
# The two gates below both read it.

# specs/openapi.json is a BUILD ARTIFACT bundled from specs/src/. With the
# gates running before the package builds, the copy a prior build left may be
# stale or absent — bundle fresh first. Version pinned to the repo's
# devDependency, same as CI.
if ! run_logged "specs/src bundled into specs/openapi.json" \
    $RT run --rm -v "$REPO_ROOT":/workspace -v "$NPM_CACHE_DIR":/root/.npm -w /workspace "$NODE_IMAGE" \
    npx --yes @redocly/cli@2.34.0 bundle specs/src/openapi.json -o specs/openapi.json; then
  fail "Could not bundle the OpenAPI spec (redocly says why, above)."
  exit 1
fi

# --- Python SDK drift gate ---
#
# The Python SDK has no build: what it holds of specs/src is generated and
# COMMITTED (packages/python/sdk/src/semiont), so a spec change can leave it
# stale. Node generators write the tables and the bus vocabulary; the models
# (types.py) are written by a Python tool pinned in the package's lockfile.

if ! run_logged "the Python SDK's generated tables match specs/src" \
    $RT run --rm -v "$REPO_ROOT":/workspace -w /workspace "$NODE_IMAGE" \
    npm run generate:python:check; then
  fail "The Python SDK's generated tables are STALE (or were hand-edited) — they must match specs/src."
  echo ""
  echo -e "  Regenerate and commit:"
  echo ""
  echo -e "    ${BOLD}npm run generate:python${RESET}   (packages/python/sdk/src/semiont)"
  echo ""
  exit 1
fi

# The environment is made INSIDE the container (/venv) from the package's
# lockfile, and Python is told to write no bytecode: nothing lands in the
# working tree. Only uv's download cache is kept between runs.
#
# Making the environment and comparing report SEPARATELY, as for Go: a failed
# download is not a stale file.
MODELS_LOG=$(mktemp "$TMP_DIR/semiont-python-models.XXXXXX")
MODELS_RC=0
$RT run --rm \
  -v "$REPO_ROOT":/workspace \
  -v "$UVCACHE_DIR":/root/.cache/uv \
  -e UV_PROJECT_ENVIRONMENT=/venv \
  -e UV_LINK_MODE=copy \
  -e UV_PYTHON_DOWNLOADS=never \
  -e PYTHONDONTWRITEBYTECODE=1 \
  -w /workspace \
  "$PYTHON_IMAGE" \
  sh -c 'pip install --quiet --disable-pip-version-check --root-user-action=ignore uv || exit 3
         uv sync --quiet --locked --project packages/python/sdk || exit 3
         uv run --no-sync --project packages/python/sdk python packages/python/sdk/scripts/generate_models.py --check || exit 4' \
  > "$MODELS_LOG" 2>&1 \
  || MODELS_RC=$?

# The generator says DRIFT (or "new") when it compared and found a difference.
# Leaving with 4 without saying so, it never got that far.
if [[ "$MODELS_RC" == 0 ]]; then
  ok "the Python SDK's models match the spec"
  rm -f "$MODELS_LOG"
elif [[ "$MODELS_RC" == 4 ]] && grep -qE '^(DRIFT|new) ' "$MODELS_LOG"; then
  grep -E '^(DRIFT|new) ' "$MODELS_LOG" | sed 's/^/    /'
  fail "packages/python/sdk/src/semiont/types.py is STALE (or was hand-edited) — it must match the OpenAPI spec."
  echo ""
  echo -e "  Regenerate and commit it:"
  echo ""
  echo -e "    ${BOLD}uv run --project packages/python/sdk python packages/python/sdk/scripts/generate_models.py${RESET}"
  echo ""
  exit 1
else
  tail -40 "$MODELS_LOG" | sed 's/^/    /'
  fail "The Python SDK's models gate could not RUN (exit $MODELS_RC; its output is above)."
  echo ""
  echo -e "  This says nothing about whether the models are stale — the check never got"
  echo -e "  far enough to compare."
  echo ""
  if [[ "$MODELS_RC" == 4 ]]; then
    echo -e "  The generator refused the spec or failed. Its message names what it met."
  else
    echo -e "  The locked environment could not be made in ${BOLD}${PYTHON_IMAGE}${RESET}: a failed download"
    echo -e "  (${BOLD}pypi.org${RESET}) is the usual cause, or ${BOLD}packages/python/sdk/uv.lock${RESET} no longer"
    echo -e "  agreeing with its pyproject.toml."
  fi
  echo ""
  echo -e "  ${DIM}Output kept at: $MODELS_LOG${RESET}"
  echo ""
  exit 1
fi

# --- Python lockfile gate ---
#
# The inference drivers (packages/python/inference), the graph stores
# (packages/python/graph), the vector stores (packages/python/vectors), the
# service package (packages/python/service) and every Python image under
# images/ are Python projects with a
# lockfile each and nothing generated from specs/src, so what can go stale in
# them is the lockfile: a manifest changed without `uv lock`, in the project
# or in a package of the repository it takes. CI's job for each refuses that first
# (`uv sync --locked`), and so does a service image's build, minutes into a
# run. This refuses it here, for each, in seconds: `uv lock --check` makes no
# environment and writes nothing, and the one a working tree may hold from a
# run on the host is not looked at.

PYTHON_PROJECTS="packages/python/inference packages/python/graph packages/python/vectors packages/python/service"
for pyproject in "$REPO_ROOT"/images/*/pyproject.toml; do
  PYTHON_PROJECTS+=" images/$(basename "$(dirname "$pyproject")")"
done

for PYTHON_PROJECT in $PYTHON_PROJECTS; do
  LOCK_LOG=$(mktemp "$TMP_DIR/semiont-lock.XXXXXX")
  # Installing uv and checking report SEPARATELY, as above: a failed download
  # is not a stale lockfile.
  LOCK_RC=0
  $RT run --rm \
    -v "$REPO_ROOT":/workspace \
    -v "$UVCACHE_DIR":/root/.cache/uv \
    -e UV_PROJECT_ENVIRONMENT=/venv \
    -e UV_PYTHON_DOWNLOADS=never \
    -e PYTHONDONTWRITEBYTECODE=1 \
    -w /workspace \
    "$PYTHON_IMAGE" \
    sh -c 'pip install --quiet --disable-pip-version-check --root-user-action=ignore uv || exit 3
           uv lock --check --project "$1" || exit 4' sh "$PYTHON_PROJECT" \
    > "$LOCK_LOG" 2>&1 \
    || LOCK_RC=$?
  if [[ "$LOCK_RC" == 0 ]]; then
    rm -f "$LOCK_LOG"
  elif [[ "$LOCK_RC" == 4 ]]; then
    tail -40 "$LOCK_LOG" | sed 's/^/    /'
    fail "${PYTHON_PROJECT}/uv.lock does not agree with its manifests (uv says how, above)."
    echo ""
    echo -e "  Lock it again and commit the lockfile:"
    echo ""
    echo -e "    ${BOLD}cd ${PYTHON_PROJECT} && uv lock${RESET}"
    echo ""
    echo -e "  A project takes the SDK from this repository, and a service the package it"
    echo -e "  runs on too (the worker the inference drivers, the weaver the graph stores,"
    echo -e "  the smelter the vector stores, the librarian all three, and every service the"
    echo -e "  service package), so a change to one of their manifests is a change to its"
    echo -e "  lockfile."
    echo ""
    exit 1
  else
    tail -40 "$LOCK_LOG" | sed 's/^/    /'
    fail "The lockfile gate could not RUN for ${PYTHON_PROJECT} (exit $LOCK_RC; its output is above)."
    echo ""
    echo -e "  This says nothing about whether the lockfile is stale: ${BOLD}uv${RESET} could not be"
    echo -e "  installed in ${BOLD}${PYTHON_IMAGE}${RESET}. A failed download is the usual cause."
    echo ""
    exit 1
  fi
done
ok "the lockfiles of the $(echo $PYTHON_PROJECTS | wc -w | tr -d ' ') Python projects agree with their manifests"

# --- sdk-go drift gate ---
#
# packages/go/sdk/api/client_gen.go is GENERATED from specs/openapi.json and
# COMMITTED (see packages/go/sdk/README.md). Nothing regenerates it
# automatically, so a spec change can leave it stale. This gate regenerates
# to a scratch path inside the container (never the working tree — builds
# don't mutate source) and diffs: byte-identical or fail. Deterministic
# because the generator version is pinned.

if ! run_logged "the Go SDK's generated tables match specs/src" \
    $RT run --rm -v "$REPO_ROOT":/workspace -w /workspace "$NODE_IMAGE" \
    npm run generate:go:check; then
  fail "The Go SDK's generated tables are STALE (or were hand-edited) — they must match specs/src."
  echo ""
  echo -e "  Regenerate and commit:"
  echo ""
  echo -e "    ${BOLD}npm run generate:go${RESET}   (packages/go/sdk)"
  echo ""
  exit 1
fi

# Both Go caches are this script's own, not shared with other container
# consumers. Concurrent container VMs extracting into one shared module cache
# corrupt it — Go's cache locking is flock, which does not hold across VM
# boundaries over virtiofs — and a truncated extraction is trusted
# forever ("cannot embed directory ... contains no embeddable files").
# This script cannot run concurrently with itself (port 4873), so a private
# cache is effectively serial.
#
# The MODULE cache is persisted too, not just the build cache. Without it every
# run re-downloads the whole oapi-codegen tree (~100 MB, 21 modules), which
# lets a DNS blip take this gate down. (Go writes the module cache read-only,
# so `chmod -R u+w` before removing it by hand.)
# Caching alone is not enough: `go run <pkg>@<version>` resolves the version
# against the proxy on EVERY run — including a deprecation lookup — so a
# populated cache alone needs the network. Pointing GOPROXY at the cache's own
# download dir (a valid module proxy) serves the pinned generator locally and
# falls through to the network only on a miss: a warm cache succeeds with the
# network proxies removed entirely, and a cold cache populates through the
# fallback.


# Generation and comparison report SEPARATELY. Collapsing them into one `&&`
# makes every generator failure — a DNS blip fetching oapi-codegen, an
# unreadable spec, a container that never started — print "the OpenAPI spec
# changed without regenerating the Go client": a specific cause the gate has
# not established, and one that sends the reader to regenerate a file that was
# never stale. Ignorance is not a finding.
# The corrupt-cache signature, in ONE place: the retry below and the diagnosis
# further down must agree about what a poisoned extraction looks like, or the
# run either retries a failure it cannot fix or prints a remedy it already
# applied. `cannot embed` / `no embeddable files` is the shape a TRUNCATED
# extraction produces — the tree is THERE, so Go trusts it and never
# re-extracts, and every retry fails identically until it is removed.
CORRUPT_CACHE_RE='no such file or directory|no matching files found|cannot embed|no embeddable files|pattern .*: .*matching|cannot find package'

# Output is tee'd, not just streamed: the exit-3 handler below reads it to tell a
# CORRUPT MODULE CACHE from a network failure, and the two have opposite remedies.
# `set -o pipefail` (line 2) is what makes `$?` the container's code rather than
# tee's — without it this silently reports success on every failure.
DRIFT_LOG=$(mktemp "$TMP_DIR/semiont-drift.XXXXXX")

run_drift_check() {
  DRIFT_RC=0
  $RT run --rm \
    -v "$REPO_ROOT":/workspace \
    -v "$GOCACHE_DIR":/root/.cache/go-build \
    -v "$GOMODCACHE_DIR":/go/pkg/mod \
    -e GOPROXY="$GOPROXY_CACHED" \
    -w /workspace \
    "$GO_IMAGE" \
    sh -c 'go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.6.0 \
             -config packages/go/sdk/oapi-codegen.yaml \
             -o /tmp/client_gen.check.go specs/openapi.json || exit 3
           diff -q /tmp/client_gen.check.go packages/go/sdk/api/client_gen.go >/dev/null || exit 4' \
    > "$DRIFT_LOG" 2>&1 \
    || DRIFT_RC=$?
}

# Purge the EXTRACTED module trees, keeping cache/download — the downloads are a
# content-addressed store and a valid proxy (GOPROXY_CACHED points at it), so Go
# re-extracts from them offline. On the HOST: rm through the mount fails with
# Permission denied even as root. Go writes the cache read-only, hence the chmod.
purge_modcache_extractions() {
  chmod -R u+w "$GOMODCACHE_DIR" 2>/dev/null || true
  find "$GOMODCACHE_DIR" -mindepth 1 -maxdepth 1 ! -name cache -exec rm -rf {} + 2>/dev/null || true
}

run_drift_check

# Self-heal, once: a message telling someone to run two commands the
# script can run itself is a manual step pretending to be a diagnosis. Retried
# ONLY on the corrupt-cache signature and ONLY when the generator failed to run
# (3): a STALE client (4) is a real verdict about the spec, and re-running it on
# a fresh cache would just burn a download to reach the same answer.
if [[ "$DRIFT_RC" == 3 ]] && grep -qiE "$CORRUPT_CACHE_RE" "$DRIFT_LOG"; then
  warn "The Go module cache is corrupt (a partial extraction). Purging the extracted trees — the downloads are kept — and retrying once."
  purge_modcache_extractions
  run_drift_check
  if [[ "$DRIFT_RC" == 0 ]]; then
    ok "Recovered after purging the module cache"
  fi
fi

case "$DRIFT_RC" in
  0)
    ok "packages/go/sdk/api/client_gen.go matches specs/openapi.json"
    rm -f "$DRIFT_LOG"
    ;;
  4)
    fail "packages/go/sdk/api/client_gen.go is STALE — the OpenAPI spec changed without regenerating the Go client."
    echo ""
    echo -e "  Regenerate and commit it:"
    echo ""
    echo -e "    ${BOLD}cd packages/go/sdk && go generate ./...${RESET}"
    echo -e "    ${BOLD}git add packages/go/sdk/api/client_gen.go${RESET}   (then commit)"
    echo ""
    exit 1
    ;;
  *)
    tail -40 "$DRIFT_LOG" | sed 's/^/    /'
    fail "The sdk-go drift gate could not RUN (the generator exited $DRIFT_RC; its output is above)."
    echo ""
    echo -e "  This says nothing about whether the Go client is stale — the check never got"
    echo -e "  far enough to compare."
    echo ""
    # Two causes, opposite remedies. Telling someone to wait for the network when
    # the module cache is corrupt makes them wait for a network that is already
    # working, and the next run fails identically.
    #
    # The cache holds `cache/download` (module ZIPs — a valid proxy, and what
    # GOPROXY_CACHED points at) beside the EXTRACTED trees. A run killed
    # mid-extraction leaves a partial tree that no amount of network fixes; Go
    # re-extracts from the downloads offline once the bad tree is gone.
    # `cannot embed` / `no embeddable files` is the shape a TRUNCATED extraction
    # produces.
    # Go has two embed failures and they read nothing alike: a pattern matching
    # nothing says "no matching files found", while a directory that survived
    # with its subdirectories but none of its files says "cannot embed directory
    # X: contains no embeddable files". The second is precisely the corrupt-cache
    # signature — the tree is THERE, so Go trusts it and never re-extracts, and
    # every retry fails identically. Matching only the first would send the
    # reader to the network branch below to wait out a network that is working.
    if grep -qiE "$CORRUPT_CACHE_RE" "$DRIFT_LOG"; then
      echo -e "  ${BOLD}Cause: a corrupt Go module cache, not the network.${RESET} A previous run was"
      echo -e "  interrupted mid-extraction and left a partial module tree."
      echo ""
      echo -e "  ${BOLD}This run already purged the extracted trees and retried once${RESET}, so the"
      echo -e "  cache was not merely poisoned — it is cold, or the purge could not remove it."
      echo ""
      echo -e "  Purge by hand and see whether the error changes:"
      echo ""
      echo -e "    ${BOLD}chmod -R u+w $GOMODCACHE_DIR${RESET}"
      echo -e "    ${BOLD}find $GOMODCACHE_DIR -mindepth 1 -maxdepth 1 ! -name cache -exec rm -rf {} +${RESET}"
      echo ""
      # Everything else in this repo runs in a container, so the reflex is to run
      # this there too. It fails: rm returns "Permission denied" on the virtiofs
      # mount even as root, and the tree survives looking untouched.
      echo -e "  ${DIM}Run those on the HOST, not in a container — rm fails with Permission${RESET}"
      echo -e "  ${DIM}denied through the mount, even as root, and leaves the cache corrupt.${RESET}"
      echo ""
      echo -e "  ${DIM}Do NOT use \`go clean -modcache\` — it deletes cache/download too, costing a${RESET}"
      echo -e "  ${DIM}~100 MB re-fetch of the 21-module oapi-codegen tree and reintroducing the${RESET}"
      echo -e "  ${DIM}network dependency GOPROXY_CACHED exists to remove.${RESET}"
      echo ""
      # GOPROXY_CACHED is itself a file:// proxy, so a COLD cache with the network
      # also down produces this same wording. The purge is safe either way (Go
      # re-extracts from the downloads), but it will not help that case.
      echo -e "  ${DIM}If the purge changes nothing, the cache was cold rather than corrupt —${RESET}"
      echo -e "  ${DIM}the file:// proxy reports the same error for a missing module. Treat it${RESET}"
      echo -e "  ${DIM}as the network case below.${RESET}"
    else
      echo -e "  A failed module fetch (${BOLD}proxy.golang.org${RESET}) is the usual cause; retry once the"
      echo -e "  network is back, and the pinned generator will be cached in"
      echo -e "  ${BOLD}${GOMODCACHE_DIR}${RESET} for subsequent offline runs."
    fi
    echo ""
    echo -e "  ${DIM}Generator output kept at: $DRIFT_LOG${RESET}"
    echo ""
    exit 1
    ;;
esac

if ! run_logged "the generated Go client covers every schema" \
    $RT run --rm -v "$REPO_ROOT":/workspace -w /workspace "$NODE_IMAGE" \
    node packages/go/sdk/scripts/check-go-schema-coverage.mjs; then
  fail "The generated Go client is missing schemas (see above)."
  echo ""
  echo -e "    ${BOLD}cd packages/go/sdk && go generate ./...${RESET}"
  echo ""
  exit 1
fi

fi
