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
#     or carries a named reason here. And every entry of the allowlist is
#     still a read: an entry nothing reads is a reason given for something
#     that is not there. The gateway is not here: its
#     environment is specs/src/service-environment/variables.json, which
#     lint:service-environment checks in both directions.
# B2  [kb] identity census: every `config.kb?.X` read is a key the launcher
#     stages in the [kb] table (stagedServiceConfig).
# B3  archivist topology census: every `services.archivist.X` read is a key
#     the launcher stages in the archivist table (stagedServiceConfig).
#
# B2 and B3 read the launcher's Go source for the keys it stages. A census
# that finds none there has lost what it reads, and says so: an empty list
# would pass nothing and report nothing.
#
# Exit code: 0 if clean, 1 if violations found.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

START_GO="apps/launcher/internal/launcher/start.go"
TOPOLOGY_GO="apps/launcher/internal/launcher/topology.go"
FAIL=0

# The function that writes a service's staged config: the [kb] table and the
# archivist table are built here, and nowhere else.
staging=$(awk '/^func stagedServiceConfig\(/,/^}/' "$TOPOLOGY_GO")
if [ -z "$staging" ]; then
  echo "❌ B2/B3: no stagedServiceConfig in $TOPOLOGY_GO — the census has lost the function it reads the staged keys from."
  exit 1
fi

# staging_lines <pattern>: the lines of that function that match, or none.
# Finding none is an answer, not a failure: under `set -e` and `pipefail` a
# grep that matches nothing would otherwise end this script without a word.
staging_lines() {
  echo "$staging" | grep -E "$1" || true
}

# literal_keys: the keys of the Go map literals on the lines given.
literal_keys() {
  grep -oE '"[a-zA-Z]+":' | tr -d '":' || true
}

# Per-service runtime file sets. Approximations are deliberate and named:
# the make-meaning services are scoped to their entry files, where every env
# read of theirs lives today (the checkout-run rebuild CLIs under
# make-meaning/src/cli are out of scope — they never ride an image).
service_files() {
  case "$1" in
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
    archivist) echo archivistArgs ;;
    librarian) echo librarianArgs ;;
    *)         echo sidecarArgs ;;
  esac
}

# Named allowlist: "service VAR — reason". Every entry is either optional
# by design (a documented fallback exists) or produced inside the container
# before the server starts. An entry with neither property is a bug here.
ALLOW="
archivist SEMIONT_SKIP_REBUILD — operator escape hatch; default is to rebuild
"

allowed() { # allowed <service> <var>
  echo "$ALLOW" | grep -qE "^$1 $2 "
}

# demand_of <service>: every variable the service's runtime files read.
demand_of() {
  service_files "$1" | xargs grep -hoE 'process\.env\.[A-Z_]+' 2>/dev/null \
    | sed 's/process\.env\.//' | sort -u || true
}

# ── B1 — per-service env census ─────────────────────────────────────────────
for svc in worker smelter weaver archivist librarian; do
  demand=$(demand_of "$svc")
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

# The allowlist names only reads that exist.
while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  key="${entry%% — *}"
  svc="${key%% *}"
  var="${key#* }"
  if ! demand_of "$svc" | grep -qxF "$var"; then
    echo "❌ B1: the allowlist names \"$key\", and $svc does not read \$$var. Remove the entry."
    FAIL=1
  fi
done <<< "$ALLOW"

# ── B2 — [kb] identity census ───────────────────────────────────────────────
kb_reads=$(grep -rhoE 'config\.kb\??\.[a-zA-Z]+' packages/make-meaning/src \
  --include='*.ts' 2>/dev/null | grep -v __tests__ | sed -E 's/.*\.//' | sort -u || true)
# The table is `kb := map[string]any{…}`, and a key it may lack is assigned
# afterwards, `kb["domain"] = …`.
kb_staged=$({
  staging_lines 'kb := map\[string\]any\{' | literal_keys
  staging_lines 'kb\["[a-zA-Z]+"\] =' | sed -E 's/.*kb\["([a-zA-Z]+)"\] =.*/\1/'
} | sort -u)
if [ -z "$kb_staged" ]; then
  echo "❌ B2: stagedServiceConfig ($TOPOLOGY_GO) builds no [kb] table this census can read — it looks for \`kb := map[string]any{…}\` and \`kb[\"key\"] = …\`."
  FAIL=1
fi
for key in $kb_reads; do
  if ! echo "$kb_staged" | grep -qxF "$key"; then
    echo "❌ B2: config.kb.$key is read but stagedServiceConfig ($TOPOLOGY_GO) never stages it — the reader will see undefined in every extracted container."
    FAIL=1
  fi
done

# ── B3 — archivist topology census ──────────────────────────────────────────
arch_reads=$(grep -rhoE 'services\??\.archivist\??\.[a-zA-Z]+' apps packages \
  --include='*.ts' 2>/dev/null | grep -vE '__tests__|/dist/' | sed -E 's/.*\.//' | sort -u || true)
# The table is `env["archivist"] = map[string]any{…}`.
arch_staged=$(staging_lines 'env\["archivist"\] = map\[string\]any\{' | literal_keys | sort -u)
if [ -z "$arch_staged" ]; then
  echo "❌ B3: stagedServiceConfig ($TOPOLOGY_GO) builds no archivist table this census can read — it looks for \`env[\"archivist\"] = map[string]any{…}\`."
  FAIL=1
fi
for key in $arch_reads; do
  if ! echo "$arch_staged" | grep -qxF "$key"; then
    echo "❌ B3: services.archivist.$key is read but stagedServiceConfig ($TOPOLOGY_GO) never stages it."
    FAIL=1
  fi
done

if [ "$FAIL" -eq 0 ]; then
  echo "✅ boot-contract census clean (B1 env per service, B2 [kb] identity, B3 archivist topology)"
fi
exit "$FAIL"
