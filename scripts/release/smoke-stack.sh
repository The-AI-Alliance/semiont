#!/usr/bin/env bash
# Boot a real stack and assert what the launcher's hermetic suite cannot.
#
#   scripts/release/smoke-stack.sh latest          # the published :latest images
#   scripts/release/smoke-stack.sh 0.6.5           # one release's images
#   scripts/release/smoke-stack.sh local           # images from scripts/ci/local-build.sh
#   scripts/release/smoke-stack.sh local --e2e     # and run tests/e2e's default tier
#
# TWO AXES, and naming them separately is the point. The LAUNCHER is the one
# built from this checkout, apps/launcher/dist/semiont (scripts/ci/local-build.sh
# builds it beside the :local images), never whatever `semiont` is on PATH,
# which is usually a release; the script refuses when the binary is missing or
# older than the source it builds from. The IMAGES are the tag given here,
# written into the stack's documents init made. So a
# launcher change is testable against the images people actually run,
# publishing nothing.
#
# WHAT IT ASSERTS, and nothing more: that every health gate opens against a
# real service at a real route, that the realm the launcher STAGES imports and
# answers, that the realm allows the Browser's origin, and that `stop` releases
# every claimed port. It does NOT assert that inference works — what a model
# does is tests/e2e's question, which assumes a stack is already up and drives
# the product through a browser.
#
# WITH --e2e it asks that question too, of the stack it booted, before it stops
# it: it makes a user in the realm with `useradd`, then runs tests/e2e's
# default tier (`npm test`, which typechecks the specs and leaves out @slow) in
# the Playwright image whose tag is the version tests/e2e/package.json pins. A
# failing suite is a failed check like any other, so the container logs print
# and the stack stops. The image reaches the stack at localhost through
# `--network host`, which docker and podman have and Apple's `container` does
# not, so --e2e refuses that runtime (tests/e2e/README.md runs the suite there
# by hand, through the host bridge). The suite's packages, @semiont/core and
# @semiont/sdk, link to this checkout's packages/, which must be built:
# scripts/ci/local-build.sh builds them, as `npm run build:packages` does.
#
# THE KNOWLEDGE BASE is exactly what a new user makes: `init` with only the
# did:web domain (and, with --e2e, a larger model: see E2E_MODEL), then
# `start` with no --config, so the documents init writes and the Inference
# document it records are what boot. A new KB that could not start is the
# defect this check found on its first run.
#
# THE RUN LEAVES NOTHING BEHIND. The launcher keeps a KB's daemon state and
# secrets under a key derived from its domain, and the domain here is the same
# on every run, so a run's state is the next run's unless it goes. A run cleans
# that state before it boots (whatever an interrupted run left) and on exit
# stops the stack, unsets the browser-image setting (a setting of the
# machine's own is not restored: a local run leaves the catalog's Browser),
# cleans the state, forgets the KB in the launcher's registry, and removes the
# KB directory it made (never one SMOKE_KB names).
#
# Why this exists as a script and not as steps in a workflow: every other
# release check in this repo is one (verify-release.sh is its closest peer),
# and a check that only a runner can perform is a check nobody runs while
# debugging it. stack-smoke.yml runs it after scripts/ci/local-build.sh, or,
# given a published tag, after building only the launcher.
#
# Requires: docker (or another runtime via SMOKE_RUNTIME), git, curl, nc.

set -uo pipefail

usage() {
  echo "usage: $0 <images-tag> [--e2e]   e.g. $0 latest" >&2
  exit 2
}
IMAGES="${1:-}"
[ -n "$IMAGES" ] && [ $# -le 2 ] || usage
E2E=false
case "${2:-}" in
  "") ;;
  --e2e) E2E=true ;;
  *) usage ;;
esac
RUNTIME="${SMOKE_RUNTIME:-docker}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The model a run with --e2e binds in place of init's default. Against
# gemma3:270m, on a four-core runner with no GPU, every test the suite tags
# @model failed: a structured reply cut off at its token limit, delegated
# detection that found nothing, generations that never finished.
E2E_MODEL=gemma3:1b
if [ "$E2E" = true ]; then
  if [ "$RUNTIME" = container ]; then
    echo "--e2e runs the suite with --network host, which Apple's container has not; run it as tests/e2e/README.md says." >&2
    exit 2
  fi
  # Playwright refuses to run when the image and the library disagree, so the
  # tag is the version the suite pins, read here and never typed.
  PLAYWRIGHT=$(sed -n 's/^ *"@playwright\/test": "\(.*\)",\{0,1\}$/\1/p' "$REPO_ROOT/tests/e2e/package.json")
  if ! printf '%s' "$PLAYWRIGHT" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+'; then
    echo "tests/e2e/package.json pins no exact @playwright/test version (read '$PLAYWRIGHT'), so no Playwright image can be named." >&2
    exit 2
  fi
fi
SEMIONT="$REPO_ROOT/apps/launcher/dist/semiont"
if [ ! -x "$SEMIONT" ]; then
  echo "No launcher built from this checkout at $SEMIONT. Build it with scripts/ci/local-build.sh." >&2
  exit 2
fi
# The launcher compiles apps/launcher and packages/sdk-go; a source file newer
# than the binary means the binary is not this checkout's launcher.
NEWER=$(find "$REPO_ROOT/apps/launcher" "$REPO_ROOT/packages/sdk-go" -path "$REPO_ROOT/apps/launcher/dist" -prune -o \
  \( \( -name '*.go' ! -name '*_test.go' \) -o -name go.mod -o -name go.sum \) -newer "$SEMIONT" -print | head -1)
if [ -n "$NEWER" ]; then
  echo "$SEMIONT is older than ${NEWER#"$REPO_ROOT"/}. Rebuild it with scripts/ci/local-build.sh." >&2
  exit 2
fi
KB="${SMOKE_KB:-$(mktemp -d)/kb}"

PASS=0; FAIL=0
ok()    { printf '  \033[32mok\033[0m   %s\n' "$1"; PASS=$((PASS+1)); }
bad()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cleanup() {
  cd / || return
  "$SEMIONT" stop --runtime "$RUNTIME" >/dev/null 2>&1
  "$SEMIONT" settings browser-image --unset >/dev/null 2>&1
  "$SEMIONT" clean --root "$KB" >/dev/null 2>&1
  "$SEMIONT" forget "$KB" >/dev/null 2>&1
  [ -z "${SMOKE_KB:-}" ] && rm -rf "$(dirname "$KB")"
}
trap cleanup EXIT

head_ "Knowledge base ($KB)"
echo "  launcher: $SEMIONT ($("$SEMIONT" --version))"
mkdir -p "$KB" && cd "$KB" || exit 1
git init -q && git config user.email smoke@example.com && git config user.name smoke
# The domain is the one setting with no safe default, so it is the one flag.
INIT_MODEL=()
[ "$E2E" = true ] && INIT_MODEL=(--model "$E2E_MODEL")
# An empty array under `set -u` is an unbound variable to macOS's bash 3.2.
if "$SEMIONT" init --yes --domain example.github.io:stack-smoke ${INIT_MODEL[@]+"${INIT_MODEL[@]}"} >/dev/null; then
  ok "init wrote a config the plan deriver accepts"
else
  bad "init refused"; exit 1
fi
if "$SEMIONT" clean --root "$KB" >/dev/null; then
  ok "no state from an earlier run remains"
else
  bad "clean refused the state an earlier run left"; exit 1
fi
# The images are the documents' to name: init names :latest, and the run names
# the set it was given, as a person choosing a release would. The Browser is
# the machine's, so its image is the machine's browser-image setting, unset
# again on exit.
for doc in "$KB"/.semiont/stack/*.yaml; do
  sed "s#\(ghcr.io/the-ai-alliance/semiont-[a-z]*\):latest#\1:$IMAGES#" "$doc" > "$doc.next" && mv "$doc.next" "$doc"
done
if [ "$IMAGES" = latest ] || ! grep -q 'ghcr.io/the-ai-alliance/semiont-[a-z]*:latest' "$KB"/.semiont/stack/*.yaml; then
  ok "the documents name the :$IMAGES images"
else
  bad "a document still names a :latest image"; exit 1
fi
if "$SEMIONT" settings browser-image "ghcr.io/the-ai-alliance/semiont-browser:$IMAGES" >/dev/null; then
  ok "the Browser runs :$IMAGES"
else
  bad "the browser-image setting refused :$IMAGES"; exit 1
fi

head_ "Boot from :$IMAGES on $RUNTIME"
# No --config: a new KB records the config it was made with, and `start` reads
# that. Its defaults serve inference and embedding from Ollama: the host's when
# one answers, otherwise a container that pulls the two small models.
if "$SEMIONT" start --runtime "$RUNTIME"; then
  ok "every health gate opened against a real service"
else
  bad "the stack did not come up"
fi

head_ "Status"
# `status --root` is the health-coded form: it exits non-zero when a core row
# is unhealthy, so the exit status IS the assertion.
if "$SEMIONT" status --root "$KB"; then ok "every core row healthy"; else bad "a core row is unhealthy"; fi

head_ "The realm the launcher staged"
# If the import silently produced a different realm, this 404s.
curl -fsS http://localhost:8080/realms/semiont >/dev/null \
  && ok "realm 'semiont' answers" || bad "realm 'semiont' does not answer"
curl -fsS http://localhost:8080/realms/semiont/.well-known/openid-configuration >/dev/null \
  && ok "discovery answers" || bad "discovery does not answer"

head_ "The realm allows the Browser's origin"
# BROWSER-SIGNIN-ORIGIN, live. The Browser exchanges its code from
# http://localhost:3000, so Keycloak must echo that origin back. A bogus code
# is fine — the CORS header is decided before the code is, which is what makes
# this a one-variable test.
HDR=$(curl -s -D- -o /dev/null -X POST \
  -H "Origin: http://localhost:3000" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "grant_type=authorization_code&client_id=semiont-browser&code=bogus&redirect_uri=http://localhost:3000/en/auth/callback" \
  http://localhost:8080/realms/semiont/protocol/openid-connect/token \
  | tr -d '\r' | grep -i '^access-control-allow-origin:')
case "$HDR" in
  *"http://localhost:3000"*) ok "origin echoed: $HDR" ;;
  *) bad "the realm did not allow http://localhost:3000 — a freshly imported realm cannot complete sign-in" ;;
esac

if [ "$E2E" = true ]; then
  head_ "The e2e default tier, in mcr.microsoft.com/playwright:v$PLAYWRIGHT-noble"
  # A fresh realm has no users. The suite's is made here, with a password made
  # here and known to nothing else, and both reach the suite under the names
  # playwright.config.ts reads. The password goes to useradd on stdin and to
  # the suite's container by name from this environment, never in an argument.
  E2E_EMAIL=e2e@example.com
  E2E_PASSWORD=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  export E2E_EMAIL E2E_PASSWORD
  if printf '%s\n' "$E2E_PASSWORD" | "$SEMIONT" useradd --email "$E2E_EMAIL" --runtime "$RUNTIME" >/dev/null; then
    ok "useradd made $E2E_EMAIL in the realm"
    # tests/e2e is not a root workspace, so its dependencies are its own. The
    # JSON report beside the list and HTML ones is for whoever summarises the
    # run: PLAYWRIGHT_JSON_OUTPUT_NAME is Playwright's, and test-results/ is
    # the suite's output directory, emptied when a run begins.
    STARTED=$SECONDS
    if "$RUNTIME" run --rm --network host --ipc host \
      -v "$REPO_ROOT":/workspace -w /workspace/tests/e2e \
      -e E2E_EMAIL -e E2E_PASSWORD \
      -e E2E_BROWSER_URL=http://localhost:3000 \
      -e E2E_GATEWAY_URL=http://localhost:4000 \
      -e PLAYWRIGHT_JSON_OUTPUT_NAME=test-results/report.json \
      -e CI=1 \
      "mcr.microsoft.com/playwright:v$PLAYWRIGHT-noble" \
      sh -c 'npm ci && npm test -- --reporter=list,html,json'; then
      ok "the default tier passed ($((SECONDS - STARTED))s)"
    else
      bad "the default tier failed ($((SECONDS - STARTED))s): tests/e2e/playwright-report holds the report"
    fi
  else
    bad "useradd refused $E2E_EMAIL, so the suite has no one to sign in as"
  fi
fi

# `stop` removes the containers and their logs with them, so a failed run
# prints each one's recent log first.
if [ "$FAIL" -gt 0 ]; then
  head_ "Container logs"
  case "$RUNTIME" in
    container) NAMES=$(container ls -a -q) ;;
    *)         NAMES=$("$RUNTIME" ps -a --format '{{.Names}}') ;;
  esac
  for NAME in $NAMES; do
    case "$NAME" in semiont-*) ;; *) continue ;; esac
    printf '\n--- %s\n' "$NAME"
    case "$RUNTIME" in
      container) container logs -n 50 "$NAME" 2>&1 ;;
      *)         "$RUNTIME" logs --tail 50 "$NAME" 2>&1 ;;
    esac
  done
fi

head_ "Stop releases every claimed port"
"$SEMIONT" stop --runtime "$RUNTIME" >/dev/null
HELD=""
for p in 4000 5432 7474 6333 8080 4222 24100 24101 24102 24103 24104 24105; do
  nc -z localhost "$p" 2>/dev/null && HELD="$HELD $p"
done
[ -z "$HELD" ] && ok "no stack port still held" || bad "still held:$HELD"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
