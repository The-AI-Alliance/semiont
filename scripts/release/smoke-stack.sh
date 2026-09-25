#!/usr/bin/env bash
# Boot a real stack and assert what the launcher's hermetic suite cannot.
#
#   scripts/release/smoke-stack.sh latest          # the published :latest images
#   scripts/release/smoke-stack.sh 0.6.5           # one release's images
#   scripts/release/smoke-stack.sh local           # images from scripts/ci/local-build.sh
#
# TWO AXES, and naming them separately is the point. The LAUNCHER is whatever
# `semiont` is on PATH — build it from the branch you are testing. The IMAGES
# are the tag given here. So a launcher change is testable against the images
# people actually run, publishing nothing.
#
# WHAT IT ASSERTS, and nothing more: that every health gate opens against a
# real service at a real route, that the realm the launcher STAGES imports and
# answers, that the realm allows the Browser's origin, and that `stop` releases
# every claimed port. It does NOT assert that inference works — the model
# credential here is a placeholder, and what a model does is tests/e2e's
# question, which assumes a stack is already up and drives the product through
# a browser.
#
# Why this exists as a script and not as steps in a workflow: every other
# release check in this repo is one (verify-release.sh is its closest peer),
# and a check that only a runner can perform is a check nobody runs while
# debugging it.
#
# Requires: docker (or another runtime via --runtime), git, curl, nc.

set -uo pipefail

IMAGES="${1:-}"
if [ -z "$IMAGES" ]; then
  echo "usage: $0 <images-tag>   e.g. $0 latest" >&2
  exit 2
fi
RUNTIME="${SMOKE_RUNTIME:-docker}"
KB="${SMOKE_KB:-$(mktemp -d)/kb}"

PASS=0; FAIL=0
ok()    { printf '  \033[32mok\033[0m   %s\n' "$1"; PASS=$((PASS+1)); }
bad()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# The config's ${ANTHROPIC_API_KEY} must be SET or the launcher refuses to
# start, by design. A placeholder is honest here because nothing below asks a
# model to do anything; it is not a credential and must never become one.
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-smoke-placeholder-not-a-credential}"
# Selects the image tag. Without it the launcher takes `latest`, which is the
# right default and the wrong thing to assume when the point is to name a set.
export SEMIONT_VERSION="$IMAGES"

head_ "Knowledge base ($KB)"
mkdir -p "$KB" && cd "$KB" || exit 1
git init -q && git config user.email smoke@example.com && git config user.name smoke
# --config anthropic below, because that is what `init --inference anthropic`
# writes; start's own default names ollama-gemma, which this KB has no copy of.
if semiont init --yes --name stack-smoke --domain example.github.io:stack-smoke \
     --inference anthropic --model claude-sonnet-4-5-20250929 \
     --embedding ollama:nomic-embed-text >/dev/null; then
  ok "init wrote a config the plan deriver accepts"
else
  bad "init refused"; exit 1
fi

head_ "Boot from :$IMAGES on $RUNTIME"
if semiont start --runtime "$RUNTIME" --config anthropic; then
  ok "every health gate opened against a real service"
else
  bad "the stack did not come up"
fi

head_ "Status"
# `status --root` is the health-coded form: it exits non-zero when a core row
# is unhealthy, so the exit status IS the assertion.
if semiont status --root "$KB"; then ok "every core row healthy"; else bad "a core row is unhealthy"; fi

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

head_ "Stop releases every claimed port"
semiont stop --runtime "$RUNTIME" >/dev/null
HELD=""
for p in 4000 5432 7474 6333 8080 4222 24100 24101 24102 24103 24104 24105; do
  nc -z localhost "$p" 2>/dev/null && HELD="$HELD $p"
done
[ -z "$HELD" ] && ok "no stack port still held" || bad "still held:$HELD"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
