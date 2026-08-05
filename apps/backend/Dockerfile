# Stage 1: install. Unlike the other service images, the backend does NOT discard
# npm afterward — the runtime stage copies it over for `npx prisma` (see below).
#
# The image runs @semiont/backend directly — there is no CLI layer. The package
# and its lazy peers install into /home/semiont/.local/share/semiont.
# neo4j-driver and @qdrant/js-client-rest are lazy peers of @semiont/graph and
# @semiont/vector (loaded at connect time) — the backend dials both, so they are
# bundled here explicitly rather than installed at startup.
#
# Base is node:24-alpine, NOT node:26 like the frontend: node 26's built-in undici
# is incompatible with the qdrant client's undici@6 (throws "invalid onError
# method" on connect), and the qdrant client has no newer release that fixes it.
FROM node:24-alpine AS installer
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG SEMIONT_VERSION=latest
# The backend KEEPS npm at runtime (for `npx prisma`), so npm's own bundled deps
# ship in the image and face the Trivy gate. node:24-alpine's npm (11.16.0) bundles
# tar 7.5.15 (CVE-2026-59873 CRITICAL, CVE-2026-59874 HIGH), brace-expansion 5.0.6
# (CVE-2026-13149 HIGH), and undici 6.26.0 (CVE-2026-12151 HIGH). Pin npm to 12.0.1,
# which bundles tar 7.5.19, brace-expansion 5.0.7, and undici 6.27.0 — all fixed at
# the time of the pin. (brace-expansion 5.0.7 later drew its own CVE — patched below.)
RUN npm config set registry $NPM_REGISTRY && \
    npm install -g npm@12.0.1 && \
    npm install @semiont/backend@${SEMIONT_VERSION} neo4j-driver @qdrant/js-client-rest \
      --prefix /home/semiont/.local/share/semiont && \
    npm cache clean --force

# Generate the Prisma client. This is NOT optional: dist/index.js leaves
# @prisma/client external, and `npm install` does not generate a client for a
# schema that lives inside a dependency — so without this step the very first
# import of the backend's db module dies on
# `Cannot find module '.prisma/client/default'` (it constructs the client at
# module scope, so nothing even reaches a query).
#
# Build time, not container start: generate reads prisma/schema.prisma and writes
# code, and the schema ships in this image — nothing about its output depends on
# the deployment. (Contrast `migrate deploy` in the CMD, which needs the live
# database and therefore cannot move here.) The images are built per-arch, so
# each platform's build produces its own client; that was the original reason
# this ran at startup, and multi-platform builds answer it.
#
# Output lands in the prefix's node_modules/.prisma + node_modules/@prisma/client,
# inside the tree the runtime stage COPYs — verified, not assumed.
RUN cd /home/semiont/.local/share/semiont/node_modules/@semiont/backend && \
    npx prisma generate --schema=prisma/schema.prisma && \
    test -d /home/semiont/.local/share/semiont/node_modules/.prisma/client

# SELF-RETIRING PATCH — when this step FAILS the build, DELETE this whole block.
#
# npm 12.0.1 is the newest npm published, and it bundles brace-expansion 5.0.7,
# which carries CVE-2026-14257 (HIGH: DoS via unbounded expansion length). No npm
# release ships the fix (5.0.8) yet, so there is no version to bump to — we replace
# npm's bundled copy in place, exactly as the (now-retired) undici patch once did.
#
# The guard is what makes this safe to leave here: it FAILS the build the moment
# npm bundles >= 5.0.8, so the patch can never silently downgrade npm's own newer
# copy and re-introduce a vulnerability. It announces its own obsolescence instead
# of rotting unnoticed.
RUN set -eu; \
    WANT=5.0.8; \
    for p in $(find /usr/local/lib/node_modules/npm -type d -path '*/node_modules/brace-expansion'); do \
      HAVE=$(node -pe "require('$p/package.json').version"); \
      if node -e 'const c=(a,b)=>{a=a.split(".").map(Number);b=b.split(".").map(Number);for(let i=0;i<3;i++){const d=(a[i]||0)-(b[i]||0);if(d)return d}return 0};process.exit(c(process.argv[1],process.argv[2])>=0?0:1)' "$HAVE" "$WANT"; then \
        echo "npm now bundles brace-expansion $HAVE (>= $WANT) at $p."; \
        echo "DELETE the self-retiring patch block in apps/backend/Dockerfile."; \
        exit 1; \
      fi; \
    done; \
    npm pack brace-expansion@$WANT --pack-destination /tmp >/dev/null; \
    tar -xzf /tmp/brace-expansion-$WANT.tgz -C /tmp; \
    find /usr/local/lib/node_modules/npm -type d -path '*/node_modules/brace-expansion' \
      -exec sh -c 'rm -rf "$1" && cp -a /tmp/package "$1"' _ {} \;; \
    rm -rf /tmp/brace-expansion-$WANT.tgz /tmp/package

# Stage 2: runtime — node + git + npm. Unlike the other service images, the
# backend KEEPS npm because the CMD shells out to `npx prisma migrate deploy`
# before starting. (`prisma generate` no longer needs it at runtime — that moved
# to the installer stage above.)
FROM node:24-alpine
# Re-declared: ARG does not cross stages, and the start-readiness assertion near
# the CMD names this version when the installed package is too old to satisfy it.
ARG SEMIONT_VERSION=latest
# Patch base-image OS packages so alpine security fixes apply even when the
# node:24-alpine snapshot hasn't been rebuilt against them yet.
RUN apk upgrade --no-cache && \
    apk add --no-cache git && \
    # /kb is bind-mounted from the host. When the host UID doesn't match the
    # in-container semiont user (UID 1001), git's CVE-2022-24765 dubious-ownership
    # check refuses to operate. --system writes /etc/gitconfig, applied to all
    # users in the image.
    git config --system --add safe.directory /kb

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 semiont

# npm/npx (pinned + patched in the installer stage) for `npx prisma`, plus the
# backend package and its lazy peers.
COPY --from=installer /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=installer /usr/local/bin /usr/local/bin
COPY --from=installer --chown=semiont:nodejs /home/semiont/.local/share/semiont /home/semiont/.local/share/semiont

# The backend KEEPS npm/npx (see the base-image note above): the entrypoint runs
# `npx prisma migrate deploy` before starting, so removing npx makes the backend
# fail to start. npm is pinned to 12.0.1 in the installer stage above,
# with its bundled brace-expansion patched there, so keeping npm is clean for the
# Trivy gate.
#
# We still drop three things pulled transitively but never loaded at runtime:
#   - the TypeScript compiler: `typescript` + its native `@typescript/*` Go
#     binaries (via the qdrant client's dep chain); the native `tsc` carries a
#     Go-stdlib CVE (CVE-2026-39822).
#   - `elkjs`: pulled by @prisma/studio-core (via prisma@7.9.0) for Prisma
#     Studio's graph layout. It is EPL-2.0 — not on the license allowlist — and
#     is lazy-loaded only by the Studio GUI, which the backend never runs (it
#     shells out to `npx prisma migrate deploy`). studio-core itself stays:
#     it is Apache-2.0 and prisma's CLI top-level-requires it (removing it breaks
#     the CLI, and `migrate deploy` still runs at start), while removing only
#     elkjs leaves the CLI working.
#   - `find-my-way`: the HTTP router @prisma/dev pins at exactly 9.6.0 (so no
#     semver bump can reach the fixed 9.7.0), carrying CVE-2026-47219 (HIGH:
#     HTTP/2 DDoS). It serves Prisma's dev server, which the backend never runs.
#     @prisma/dev itself stays — prisma's CLI top-level-requires
#     `@prisma/dev/internal/state`; removing only find-my-way leaves the CLI working.
RUN find /usr/local/lib/node_modules /home/semiont/.local/share/semiont \
      -type d \( -name typescript -o -name '@typescript' -o -name elkjs \
                 -o -name find-my-way \) \
      -prune -exec rm -rf {} +

COPY LICENSE apps/backend/NOTICE /home/semiont/

WORKDIR /kb
RUN chown semiont:nodejs /kb
USER semiont

ENV NODE_ENV=production
# Deliberately NO explicit --max-old-space-size: node:24 is cgroup-aware and
# sizes the heap to ~half the container memory limit, making --memory /
# mem_limit the single memory knob. A baked heap override defeats that — it
# licensed the heap past small container limits (OOM-kill instead of GC
# pressure) and was an unmeasured 2026-04 artifact, not a profiled need.
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/api/health', r => process.exit(r.statusCode < 400 ? 0 : 1)).on('error', () => process.exit(1))"

# The KB working tree is bind-mounted at /kb and the TOML config at
# ~/.semiontconfig; the backend reads both (see src/index.ts). These were injected
# by the CLI before it was retired — they are fixed inside the container, so bake
# them here.
ENV SEMIONT_ROOT=/kb
# Where the launcher mounts this KB's anchored-text store. Declared here for
# the same reason SEMIONT_ROOT is: the container-side path is a constant of the
# image, and the host side is the launcher's business. Unset outside a
# container, where SemiontProject falls back to $XDG_STATE_HOME/semiont/{name}/
# anchored-text beside the projections.
ENV SEMIONT_ANCHORED_TEXT_DIR=/anchored-text
ENV SEMIONT_ENV=local
ENV BACKEND_DIR=/home/semiont/.local/share/semiont/node_modules/@semiont/backend

# The package's declared bins, linked here by `npm install --prefix`. On PATH so
# `semiont useradd` can `container exec … semiont-useradd <args>` — a bare command
# name with argv passed straight through, no `sh -c`. That matters because the
# password is IN that argv: routing it through a shell to expand $BACKEND_DIR
# would let shell metacharacters in a password be mangled or interpreted.
ENV PATH="/home/semiont/.local/share/semiont/node_modules/.bin:${PATH}"

# Assert the image can actually start, using the SAME variable the CMD will.
# The retired CLI checked this at every container start ("Backend not
# provisioned…", "Backend entry point not found at…"); those were start-time
# checks on facts the build fixes, so they belong here instead — one failure for
# a maintainer in CI beats one per user at first boot.
#
# Placed after the COPY, the prune, and the ENV so it validates all three at
# once: an install-prefix change, a prune that reached too far, or a drifted
# BACKEND_DIR each fail the build here rather than surfacing at runtime as a bare
# `node: cannot find module`. (The installer stage's own `test -d` stays — it
# pins the generate step where it runs, so a failure there names the right step.)
RUN test -f "$BACKEND_DIR/dist/index.js" \
      || { echo "BACKEND_DIR does not contain dist/index.js: $BACKEND_DIR"; exit 1; }; \
    test -f "$BACKEND_DIR/prisma/schema.prisma" \
      || { echo "no prisma schema under $BACKEND_DIR — migrate deploy would fail at start"; exit 1; }; \
    test -d /home/semiont/.local/share/semiont/node_modules/.prisma/client \
      || { echo "generated prisma client missing from the runtime image (pruned?)"; exit 1; }; \
    test -f "$BACKEND_DIR/dist/cli/db-url.js" \
      || { echo "@semiont/backend@${SEMIONT_VERSION} predates dist/cli/db-url.js, which this CMD needs to derive DATABASE_URL — build with a version that ships it"; exit 1; }; \
    command -v semiont-useradd >/dev/null \
      || { echo "semiont-useradd is not on PATH — \`semiont useradd\` execs it by name; check the package's bin entry and the PATH above"; exit 1; }

# Derive DATABASE_URL, apply pending migrations, then hand the container over to
# node. `exec` makes node PID 1, so it receives SIGTERM directly and logs to
# stdout — unlike the retired CLI path, which detached node and kept the
# container alive with `tail -f` on a log file.
#
# The derivation is the CLI's old `backend-start.ts` job, restored: the config
# holds the database credentials, and nothing else translated them into a
# connection string. It runs HERE, as its own process, because
#
#   - `migrate deploy` is a separate process that reads the datasource url from
#     prisma.config.ts (process.env.DATABASE_URL), so a value assembled inside
#     the server would be invisible to it, and
#   - inside the server it would be too late anyway: the bundler emits module
#     bodies in dependency order, so src/db.ts constructs its client before
#     index.ts's own top-level code runs.
#
# Setting it before either process starts removes both problems. And because it
# is set INSIDE the container rather than passed with --env, the password never
# appears in `container inspect` — the same rule the launcher keeps for the admin
# password (see backendArgs in apps/launcher/internal/launcher/start.go).
#
# Required in the environment:
#   JWT_SECRET     — >= 32 chars; `semiont start` generates one per KB and injects it
#   SEMIONT_WORKER_SECRET — for the agent-token exchange
# Optional:
#   DATABASE_URL   — set it to override the config-derived value (an external or
#                    TLS-requiring database); when set, the derivation is skipped
CMD set -e; \
    if [ -z "${DATABASE_URL:-}" ]; then \
      DATABASE_URL="$(node "$BACKEND_DIR/dist/cli/db-url.js")"; \
      export DATABASE_URL; \
    fi; \
    (cd "$BACKEND_DIR" && npx prisma migrate deploy --schema=prisma/schema.prisma); \
    exec node "$BACKEND_DIR/dist/index.js"
