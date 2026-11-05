#!/usr/bin/env bash
# Boot a real stack and assert what the launcher's hermetic suite cannot.
#
#   images/tests/stack/smoke-stack.sh up local          # boot and check a stack of :local images; leave it up
#   images/tests/stack/smoke-stack.sh e2e               # run images/e2e's default tier beside it
#   images/tests/stack/smoke-stack.sh down              # stop it, and check every port is released
#   images/tests/stack/smoke-stack.sh run 0.6.5 --e2e   # all three in one run, as Stack Smoke does
#
# TWO AXES, and naming them separately is the point. The LAUNCHER is the one
# built from this checkout, apps/launcher/dist/semiont (images/scripts/build-session.sh
# builds it beside the :local images), never whatever `semiont` is on PATH,
# which is usually a release. UP and E2E build it (images/scripts/build-session.sh
# launcher, as make launcher does) when it is missing or older than the source it
# builds from; DOWN stops what UP started with the launcher that is there. The IMAGES are the tag `up` is given,
# written into the stack's documents init made. So a launcher change is
# testable against the images people actually run, publishing nothing.
#
# UP asserts, and nothing more: that every health gate opens against a real
# service at a real route, that the realm the start CREATES through Keycloak's
# admin API answers, and that the realm allows the Browser's origin. Its
# knowledge base is exactly what a new user makes: `init` with only the did:web
# domain, then `start` with no --config, so the documents init writes and the
# Inference document it records are what boot. A new KB that could not start
# is the defect this check found on its first run. A failed `up` prints the
# containers' logs and stops what it started.
#
# E2E asks what a model does, which UP does not. Each run makes a knowledge
# base of its own beside UP's, as `init` makes one, with a domain no other run
# has, on the images UP's documents name: its start joins the shared
# containers UP's left running and gives it a gateway port of its own. It makes
# a user in that knowledge base's realm with `useradd`, then runs images/e2e's
# default tier less its @model tests (`npm run test:ci`, which typechecks the
# specs and leaves out @slow and @model) against its gateway, in the Playwright
# image whose tag is the version images/e2e/package.json pins. On exit it stops,
# cleans and forgets that knowledge base, leaving UP's running. The suite's
# assertions are made against a knowledge base no earlier run touched: some of
# them hold only on a fresh one. The image reaches the stack at localhost
# through `--network host` on Docker and Podman, or the existing localhost
# bridge on Apple container. The suite's packages, @semiont/core and
# @semiont/sdk, link to this checkout's packages/, which must be built:
# images/scripts/build-session.sh builds them, as `npm run build:packages` does.
#
# DOWN stops UP's stack, puts back the Browser's and Worker's documents as UP
# found them (the launcher's own, if there were none), cleans the state,
# forgets the knowledge base in the launcher's registry, removes its directory
# (never one SMOKE_KB names), and asserts that every claimed port is released.
#
# THE STATE between them is UP's knowledge base, at SMOKE_KB or under the
# user's cache directory, with the machine's documents as UP found them beside
# it. The launcher keeps a KB's daemon state and secrets under a key derived
# from its domain, and UP's domain is the same on every run, so UP cleans that
# state before it boots (whatever an interrupted run left).
#
# Why this exists as a script and not as steps in a workflow: every other
# release check in this repo is one (verify-release.sh is its closest peer),
# and a check that only a runner can perform is a check nobody runs while
# debugging it. stack-smoke.yml runs `run` after make local-build, or, given a
# published tag, on its own.
#
# Requires: a responding container runtime (CONTAINER_RUNTIME selects one), git, curl, nc.

set -uo pipefail

SELF="${BASH_SOURCE[0]}"
usage() {
  {
    echo "usage: $SELF up <images-tag>          e.g. $SELF up local"
    echo "       $SELF e2e"
    echo "       $SELF down"
    echo "       $SELF run <images-tag> [--e2e]"
  } >&2
  exit 2
}
COMMAND="${1:-}"
[ $# -gt 0 ] && shift
E2E=false
case "$COMMAND" in
  up)
    [ $# -eq 1 ] && [ -n "$1" ] || usage
    IMAGES="$1" ;;
  run)
    [ $# -ge 1 ] && [ $# -le 2 ] && [ -n "$1" ] || usage
    IMAGES="$1"
    case "${2:-}" in
      "") ;;
      --e2e) E2E=true ;;
      *) usage ;;
    esac ;;
  e2e) [ $# -eq 0 ] || usage; E2E=true ;;
  down) [ $# -eq 0 ] || usage ;;
  *) usage ;;
esac

if [ "$COMMAND" = run ]; then
  bash "$SELF" up "$IMAGES" || exit 1
  trap 'bash "$SELF" down >/dev/null; exit 1' INT TERM
  STATUS=0
  if [ "$E2E" = true ]; then bash "$SELF" e2e || STATUS=1; fi
  bash "$SELF" down || STATUS=1
  exit "$STATUS"
fi

REPO_ROOT="$(cd "$(dirname "$SELF")/../../.." && pwd)"
source "$REPO_ROOT/images/scripts/container-runtime.sh"
RUNTIME=$(detect_container_runtime) || exit 2
E2E_NETWORK=(--network host --ipc host)
if [[ "$RUNTIME" == container ]]; then E2E_NETWORK=(); fi
if [ "$E2E" = true ]; then
  # Playwright refuses to run when the image and the library disagree, so the
  # tag is the version the suite pins, read here and never typed.
  PLAYWRIGHT=$(sed -n 's/^ *"@playwright\/test": "\(.*\)",\{0,1\}$/\1/p' "$REPO_ROOT/images/e2e/package.json")
  if ! printf '%s' "$PLAYWRIGHT" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+'; then
    echo "images/e2e/package.json pins no exact @playwright/test version (read '$PLAYWRIGHT'), so no Playwright image can be named." >&2
    exit 2
  fi
fi
SEMIONT="$REPO_ROOT/apps/launcher/dist/semiont"
# The launcher compiles apps/launcher, packages/go/launcher and packages/go/sdk; a source file newer
# than the binary means the binary is not this checkout's launcher.
newer_source() {
  find "$REPO_ROOT/apps/launcher" "$REPO_ROOT/packages/go/launcher" "$REPO_ROOT/packages/go/sdk" -path "$REPO_ROOT/apps/launcher/dist" -prune -o \
    \( \( -name '*.go' ! -name '*_test.go' \) -o -name go.mod -o -name go.sum \) -newer "$SEMIONT" -print | head -1
}
if [ "$COMMAND" != down ]; then
  if [ ! -x "$SEMIONT" ]; then
    echo "No launcher built from this checkout at $SEMIONT: building it."
  elif NEWER=$(newer_source) && [ -n "$NEWER" ]; then
    echo "$SEMIONT is older than ${NEWER#"$REPO_ROOT"/}: building it again."
  fi
  if [ ! -x "$SEMIONT" ] || [ -n "${NEWER:-}" ]; then
    bash "$REPO_ROOT/images/scripts/build-session.sh" launcher || exit 2
    # Built from the source as it is now. Go leaves a binary its build did not change as it
    # was, older than the source a comment changed, so the time is set here.
    touch "$SEMIONT"
  fi
elif [ ! -x "$SEMIONT" ]; then
  echo "No launcher built from this checkout at $SEMIONT, so nothing can stop what up started. Build it with make launcher." >&2
  exit 2
fi

KB="${SMOKE_KB:-${XDG_CACHE_HOME:-$HOME/.cache}/semiont/stack-smoke/kb}"
# The machine's documents as UP found them: <service>.yaml, and <service>.path naming where it goes back.
KEPT="$KB/.smoke-kept"

PASS=0; FAIL=0
ok()    { printf '  \033[32mok\033[0m   %s\n' "$1"; PASS=$((PASS+1)); }
bad()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }
summary() { printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]; }

# `stop` removes the containers and their logs with them, so a failed run
# prints each one's recent log first.
print_logs() {
  local names name
  head_ "Container logs"
  case "$RUNTIME" in
    container) names=$(container ls -a -q) ;;
    *)         names=$("$RUNTIME" ps -a --format '{{.Names}}') ;;
  esac
  for name in $names; do
    case "$name" in semiont-*) ;; *) continue ;; esac
    printf '\n--- %s\n' "$name"
    case "$RUNTIME" in
      container) container logs -n 50 "$name" 2>&1 ;;
      *)         "$RUNTIME" logs --tail 50 "$name" 2>&1 ;;
    esac
  done
}

# init_kb <directory> <domain> <images-tag>: a knowledge base as a new user
# makes one, its documents naming the tag's images. The images are the
# documents' to name: init names :latest, and the run names the set it was
# given, as a person choosing a release would.
init_kb() {
  local dir="$1" domain="$2" tag="$3" doc
  head_ "Knowledge base ($dir)"
  echo "  launcher: $SEMIONT ($("$SEMIONT" --version))"
  mkdir -p "$dir" && cd "$dir" || return 1
  git init -q && git config user.email smoke@example.com && git config user.name smoke
  # The domain is the one setting with no safe default, so it is the one flag.
  if "$SEMIONT" init --yes --domain "$domain" >/dev/null; then
    ok "init wrote a config the plan deriver accepts"
  else
    bad "init refused"; return 1
  fi
  for doc in "$dir"/.semiont/stack/*.yaml; do
    sed "s#\(ghcr.io/the-ai-alliance/semiont-[a-z]*\):latest#\1:$tag#" "$doc" > "$doc.next" && mv "$doc.next" "$doc"
  done
  if [ "$tag" = latest ] || ! grep -q 'ghcr.io/the-ai-alliance/semiont-[a-z]*:latest' "$dir"/.semiont/stack/*.yaml; then
    ok "the documents name the :$tag images"
  else
    bad "a document still names a :latest image"; return 1
  fi
}

# start_kb: start the knowledge base standing here. No --config: a new KB
# records the config it was made with, and `start` reads that. Its defaults
# serve inference and embedding from Ollama: the host's when one answers,
# otherwise a container that pulls the two small models.
start_kb() {
  head_ "Boot from :$1 on $RUNTIME"
  if "$SEMIONT" start --runtime "$RUNTIME"; then
    ok "every health gate opened against a real service"
  else
    bad "the stack did not come up"; return 1
  fi
}

# stop_kb <directory>: its stack alone. The shared containers stop with the
# last knowledge base recorded, so stopping E2E's leaves UP's running.
stop_kb() { "$SEMIONT" stop --root "$1" --runtime "$RUNTIME" >/dev/null 2>&1; }

# forget_kb <directory> <removable>: clean a stopped knowledge base's state,
# forget it, and remove the directory above it when the run made that.
forget_kb() {
  local dir="$1" removable="$2"
  "$SEMIONT" clean --root "$dir" >/dev/null 2>&1
  "$SEMIONT" forget "$dir" >/dev/null 2>&1
  [ "$removable" = true ] && rm -rf "$(dirname "$dir")"
}

# restore_documents: put the machine's documents back as UP found them.
restore_documents() {
  local service
  for service in browser worker; do
    [ -f "$KEPT/$service.path" ] || continue
    mv "$KEPT/$service.yaml" "$(cat "$KEPT/$service.path")" && rm -f "$KEPT/$service.path"
  done
  rm -rf "$KEPT"
}

# down_kb: UP's stack, stopped and gone, the machine's documents back. The
# stop comes first, so no Browser or Worker reads a document mid-restore.
down_kb() {
  local removable=true
  [ -n "${SMOKE_KB:-}" ] && removable=false
  stop_kb "$KB"
  restore_documents
  forget_kb "$KB" "$removable"
}

if [ "$COMMAND" = up ]; then
  if [ -e "$KEPT" ]; then
    echo "A stack from an earlier up is still recorded at $KB: take it down first (make stack-down)." >&2
    exit 1
  fi
  SUCCEEDED=false
  trap 'cd / && [ "$SUCCEEDED" = true ] || { print_logs; down_kb; }' EXIT
  init_kb "$KB" example.github.io:stack-smoke "$IMAGES" || exit 1
  if "$SEMIONT" clean --root "$KB" >/dev/null; then
    ok "no state from an earlier run remains"
  else
    bad "clean refused the state an earlier run left"; exit 1
  fi
  # The Browser and Worker are shared by the machine, so their images are
  # named in their own documents (`settings browser|worker --path`, which
  # writes one where there is none). DOWN restores both.
  mkdir -p "$KEPT" || exit 1
  for SERVICE in browser worker; do
    if ! SHARED_DOC=$("$SEMIONT" settings "$SERVICE" --path); then
      bad "the launcher named no $SERVICE document"; exit 1
    fi
    if ! cp "$SHARED_DOC" "$KEPT/$SERVICE.yaml"; then
      bad "could not keep a copy of $SHARED_DOC to put back"; exit 1
    fi
    printf '%s' "$SHARED_DOC" > "$KEPT/$SERVICE.path"
    sed "s#\(ghcr.io/the-ai-alliance/semiont-$SERVICE\):[^[:space:]]*#\1:$IMAGES#" "$SHARED_DOC" > "$SHARED_DOC.next" && mv "$SHARED_DOC.next" "$SHARED_DOC"
    if grep -q "image: ghcr.io/the-ai-alliance/semiont-$SERVICE:$IMAGES\$" "$SHARED_DOC"; then
      ok "$SERVICE's document names :$IMAGES"
    else
      bad "$SERVICE's document ($SHARED_DOC) does not name :$IMAGES"; exit 1
    fi
  done
  start_kb "$IMAGES" || exit 1

  head_ "Status"
  # `status --root` is the health-coded form: it exits non-zero when a core row
  # is unhealthy, so the exit status IS the assertion.
  if "$SEMIONT" status --root "$KB"; then ok "every core row healthy"; else bad "a core row is unhealthy"; fi

  head_ "The realm the start created"
  # The knowledge base's realm is its key, made from the domain init was given.
  # A new KB's Keycloak holds no realm until the start creates it: if it created
  # another, or none, this 404s.
  REALM=example.github.io-stack-smoke
  curl -fsS "http://localhost:8080/realms/$REALM" >/dev/null \
    && ok "realm '$REALM' answers" || bad "realm '$REALM' does not answer"
  curl -fsS "http://localhost:8080/realms/$REALM/.well-known/openid-configuration" >/dev/null \
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
    "http://localhost:8080/realms/$REALM/protocol/openid-connect/token" \
    | tr -d '\r' | grep -i '^access-control-allow-origin:')
  case "$HDR" in
    *"http://localhost:3000"*) ok "origin echoed: $HDR" ;;
    *) bad "the realm did not allow http://localhost:3000 — a freshly created realm cannot complete sign-in" ;;
  esac
  summary || exit 1
  SUCCEEDED=true
  echo "The stack is up from $KB. Run the e2e tier beside it with make e2e; stop it with make stack-down."
  exit 0
fi

if [ "$COMMAND" = down ]; then
  if [ ! -e "$KEPT" ]; then
    echo "No stack from up is recorded at $KB: nothing to take down." >&2
    exit 1
  fi
  head_ "Stop releases every claimed port"
  down_kb
  HELD=""
  for p in 4000 5432 7474 6333 8080 4222 24100 24101 24102 24103 24104 24105; do
    nc -z localhost "$p" 2>/dev/null && HELD="$HELD $p"
  done
  [ -z "$HELD" ] && ok "no stack port still held" || bad "still held:$HELD"
  summary
  exit
fi

# e2e
if [ ! -e "$KEPT" ] || ! "$SEMIONT" status --root "$KB" >/dev/null 2>&1; then
  echo "No healthy stack from up at $KB: bring one up first (make stack-up)." >&2
  exit 1
fi
IMAGES=$(grep -ho -m1 'ghcr.io/the-ai-alliance/semiont-gateway:[^[:space:]]*' "$KB/.semiont/stack/knowledge-base.yaml" | sed 's/.*://')
if [ -z "$IMAGES" ]; then
  echo "$KB/.semiont/stack/knowledge-base.yaml names no gateway image, so the images up ran cannot be read." >&2
  exit 1
fi
RUN=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
E2E_KB="$(mktemp -d)/kb"
trap 'cd / && { [ "$FAIL" -eq 0 ] || print_logs; stop_kb "$E2E_KB"; forget_kb "$E2E_KB" true; }' EXIT
init_kb "$E2E_KB" "example.github.io:e2e-$RUN" "$IMAGES" || exit 1
start_kb "$IMAGES" || exit 1
# Where clients reach this knowledge base's gateway: spec.gateway.publicURL of
# its KnowledgeBase document, a port of its own beside up's.
GATEWAY=$(awk '/^  gateway:/ { inside = 1; next } /^  [^ ]/ { inside = 0 } inside && /^    publicURL:/ { print $2; exit }' "$E2E_KB/.semiont/stack/knowledge-base.yaml")
if [ -z "$GATEWAY" ]; then
  bad "$E2E_KB/.semiont/stack/knowledge-base.yaml names no spec.gateway.publicURL"; exit 1
fi

head_ "The e2e default tier, in mcr.microsoft.com/playwright:v$PLAYWRIGHT-noble, against $GATEWAY"
# A fresh realm has no users. The suite's is made here, with a password made
# here and known to nothing else, and both reach the suite under the names
# playwright.config.ts reads. The password goes to useradd on stdin and to
# the suite's container by name from this environment, never in an argument.
E2E_EMAIL=e2e@example.com
E2E_PASSWORD=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
export E2E_EMAIL E2E_PASSWORD
if ! printf '%s\n' "$E2E_PASSWORD" | "$SEMIONT" useradd --email "$E2E_EMAIL" --runtime "$RUNTIME" >/dev/null; then
  bad "useradd refused $E2E_EMAIL, so the suite has no one to sign in as"; exit 1
fi
ok "useradd made $E2E_EMAIL in the realm"
# images/e2e is not a root workspace, so its dependencies are its own. The
# JSON report beside the list and HTML ones is for whoever summarises the
# run: PLAYWRIGHT_JSON_OUTPUT_NAME is Playwright's, and test-results/ is
# the suite's output directory, emptied when a run begins.
STARTED=$SECONDS
if "$RUNTIME" run --rm -m 8g ${E2E_NETWORK[@]+"${E2E_NETWORK[@]}"} \
  -v "$REPO_ROOT":/workspace -w /workspace/images/e2e \
  -e E2E_EMAIL -e E2E_PASSWORD \
  -e E2E_BROWSER_URL=http://localhost:3000 \
  -e "E2E_GATEWAY_URL=$GATEWAY" \
  -e PLAYWRIGHT_JSON_OUTPUT_NAME=test-results/report.json \
  -e CI=1 \
  "mcr.microsoft.com/playwright:v$PLAYWRIGHT-noble" \
  sh -c '
    set -e
    npm ci
    if [ "$1" = container ]; then
      node e2e-localhost-bridge.mjs &
      bridge_pid=$!
      trap "kill $bridge_pid 2>/dev/null || true" EXIT
      sleep 1
      kill -0 "$bridge_pid"
    fi
    npm run test:ci -- --reporter=list,html,json
  ' sh "$RUNTIME"; then
  ok "the default tier passed ($((SECONDS - STARTED))s)"
else
  bad "the default tier failed ($((SECONDS - STARTED))s): images/e2e/playwright-report holds the report"
fi
summary
