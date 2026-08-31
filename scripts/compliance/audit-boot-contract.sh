#!/usr/bin/env bash
set -euo pipefail

# Audit: boot-contract census (B1–B3). The static complement of a container
# boot smoke: catches the class where unit tests stay green (their setups
# fabricate env) while the image cannot boot — the three defects the
# SINGLE-KB-MOUNT live gates found shipped, each hidden behind the last.
#
# B1  env census, per service: every literal `process.env.X` read in a
#     service's runtime files is provided by its Dockerfile ENV, its
#     launcher argv builder's --env list, or the named allowlist below.
#     Silence cannot come back: a new env read fails until it is provided
#     or carries a named reason here.
# B2  [kb] identity census: every `config.kb?.X` read is a key
#     patchKBIdentity stages.
# B3  archivist topology census: every `services.archivist.X` read is a key
#     patchArchivistTopology stages.
#
# Exit code: 0 if clean, 1 if violations found.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

START_GO="apps/launcher/internal/launcher/start.go"
EXECUTOR_GO="apps/launcher/internal/launcher/executor.go"
FAIL=0

# Per-service runtime file sets. Approximations are deliberate and named:
# the make-meaning services are scoped to their entry files, where every env
# read of theirs lives today (the checkout-run rebuild CLIs under
# make-meaning/src/cli are out of scope — they never ride an image).
service_files() {
  case "$1" in
    gateway)   find apps/gateway/src -name '*.ts' ! -path '*__tests__*' ;;
    worker)    find packages/jobs/src -name '*.ts' ! -path '*__tests__*' ;;
    smelter)   echo packages/make-meaning/src/smelter-main.ts ;;
    weaver)    echo packages/make-meaning/src/weaver-main.ts ;;
    archivist) echo packages/make-meaning/src/archivist-main.ts ;;
    librarian) echo packages/make-meaning/src/librarian-main.ts ;;
  esac
}

dockerfile_for() {
  # One image recipe per app directory — the package a service installs is no
  # longer implied by where its Dockerfile lives.
  case "$1" in
    *) echo "apps/$1/Dockerfile" ;;
  esac
}

builder_for() {
  case "$1" in
    gateway)   echo gatewayArgs ;;
    archivist) echo archivistArgs ;;
    librarian) echo librarianArgs ;;
    *)         echo sidecarArgs ;;
  esac
}

# Named allowlist: "service VAR — reason". Every entry is either optional
# by design (a documented fallback exists) or produced inside the container
# before the server starts. An entry with neither property is a bug here.
ALLOW="
gateway DATABASE_URL — derived in-container by dist/cli/db-url.js, the first line of the image CMD
gateway DATABASE_PASSWORD — optional input to that same derivation
gateway OAUTH_ALLOWED_DOMAINS — optional env override; the staged [kb] identity is the primary source
gateway GOOGLE_CLIENT_ID — optional OAuth provider config
gateway GOOGLE_CLIENT_SECRET — optional OAuth provider config
gateway LOG_DIR — optional logging knob with a default
gateway LOG_LEVEL — optional logging knob with a default
gateway LOG_FORMAT — optional logging knob with a default
gateway HOME — present in every image runtime (config path resolution)
gateway TESTCONTAINERS_RYUK_DISABLED — test-infra guard read, inert in production
gateway VITEST_DATABASE_TESTS — test-infra guard read, inert in production
archivist SEMIONT_SKIP_REBUILD — operator escape hatch; default is to rebuild
archivist HOME — present in every image runtime (config path resolution)
librarian HOME — present in every image runtime (config path resolution)
smelter HOME — present in every image runtime (config path resolution)
weaver HOME — present in every image runtime (config path resolution)
worker HOME — present in every image runtime (config path resolution)
weaver XDG_STATE_HOME — optional; the checkpoint falls back to a container-local dir, and losing it means a full replay by design
"

allowed() { # allowed <service> <var>
  echo "$ALLOW" | grep -qE "^$1 $2 "
}

# ── B1 — per-service env census ─────────────────────────────────────────────
for svc in gateway worker smelter weaver archivist librarian; do
  demand=$(service_files "$svc" | xargs grep -hoE 'process\.env\.[A-Z_]+' 2>/dev/null \
    | sed 's/process\.env\.//' | sort -u || true)
  df=$(dockerfile_for "$svc")
  df_env=$(grep -hE '^ENV ' "$df" | sed -E 's/^ENV +//' | cut -d= -f1 || true)
  builder=$(builder_for "$svc")
  argv_env=$(awk "/^func $builder\(/,/^}/" "$START_GO" | grep -oE '"[A-Z_]+=' | tr -d '"=' || true)
  for var in $demand; do
    if echo "$df_env" | grep -qxF "$var"; then continue; fi
    if echo "$argv_env" | grep -qxF "$var"; then continue; fi
    if allowed "$svc" "$var"; then continue; fi
    echo "❌ B1: $svc reads \$$var but neither $df, $builder() in start.go, nor the named allowlist provides it:"
    service_files "$svc" | xargs grep -lE "process\.env\.$var\b" 2>/dev/null | sed 's/^/     /'
    FAIL=1
  done
done

# ── B2 — [kb] identity census ───────────────────────────────────────────────
kb_reads=$(grep -rhoE 'config\.kb\??\.[a-zA-Z]+' apps/gateway/src packages/make-meaning/src \
  --include='*.ts' 2>/dev/null | grep -v __tests__ | sed -E 's/.*\.//' | sort -u || true)
kb_staged=$(sed -n '/func patchKBIdentity/,/^}/p' "$EXECUTOR_GO" | sed 's/\\n/ /g' \
  | grep -oE '[a-zA-Z]+ = (%q|%d|%s|\[)' | awk '{print $1}' | sort -u)
for key in $kb_reads; do
  if ! echo "$kb_staged" | grep -qxF "$key"; then
    echo "❌ B2: config.kb.$key is read but patchKBIdentity (executor.go) never stages it — the reader will see undefined in every extracted container."
    FAIL=1
  fi
done

# ── B3 — archivist topology census ──────────────────────────────────────────
arch_reads=$(grep -rhoE 'services\??\.archivist\??\.[a-zA-Z]+' apps packages \
  --include='*.ts' 2>/dev/null | grep -vE '__tests__|/dist/' | sed -E 's/.*\.//' | sort -u || true)
arch_staged=$(sed -n '/func patchArchivistTopology/,/^}/p' "$EXECUTOR_GO" | sed 's/\\n/ /g' \
  | grep -oE '[a-zA-Z]+ = (%q|%d|%s|\[)' | awk '{print $1}' | sort -u)
for key in $arch_reads; do
  if ! echo "$arch_staged" | grep -qxF "$key"; then
    echo "❌ B3: services.archivist.$key is read but patchArchivistTopology (executor.go) never stages it."
    FAIL=1
  fi
done

if [ "$FAIL" -eq 0 ]; then
  echo "✅ boot-contract census clean (B1 env per service, B2 [kb] identity, B3 archivist topology)"
fi
exit "$FAIL"
