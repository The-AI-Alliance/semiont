# archivist image.
#
# THE ENTRYPOINT SOURCE IS NOT IN THIS DIRECTORY. This image installs the
# published @semiont/make-meaning and runs `dist/archivist-main.js` out of it; the
# source is packages/make-meaning/src/archivist-main.ts. Only the image
# recipe lives here — the entrypoint stayed in its package deliberately, so
# that moving it out would not have to promote ~18 of that package's
# internals to public API just to satisfy a directory layout. If you change
# the CMD, change it against that file.
#
# Stage 1: install (npm runs here, then is discarded).
#
# The Archivist is a separate image from the shared @semiont/make-meaning
# package, like smelter and weaver — separate because their dependency
# footprints differ. The Archivist's Browser serves `browse:referenced-by`
# from the graph (one call site, browser.ts — a settled decision, see
# .plans/EXTRACT-ARCHIVIST.md), so neo4j-driver is bundled here like the
# weaver's. It never dials Qdrant directly beyond the vector SEARCH the
# qdrant client in @semiont/make-meaning already carries — no extra install.
#
# Base is node:24-alpine (not node:26): node 26's built-in undici breaks the
# qdrant client's undici@6, which @semiont/make-meaning can load transitively at
# connect time. Keep in sync with the gateway image.
FROM node:24-alpine AS installer
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG SEMIONT_VERSION=latest
RUN npm config set registry $NPM_REGISTRY && \
    npm install -g @semiont/make-meaning@${SEMIONT_VERSION} neo4j-driver && \
    npm cache clean --force

# Stage 2: minimal runtime — node only, no npm. The runtime entrypoint is
# `node archivist-main.js`, so npm is build-only baggage. Removing it also drops
# the picomatch / glob / etc. CVE surface that ships inside npm's bundled
# node_modules.
FROM node:24-alpine
# Patch base-image OS packages so alpine security fixes apply even when the
# node:24-alpine snapshot hasn't been rebuilt against them yet.
RUN apk upgrade --no-cache

# The Archivist shells out to git: WorkingTreeStore's register/move/remove and
# the event store's appends all `git add` under the project root — this is the
# single git writer (GATEWAY.md D4b). smelter/weaver carry no git; this image
# must. Same as the gateway image: when the mounted KB is owned by a host UID
# that differs from the in-container semiont user (UID 1001), git's
# CVE-2022-24765 dubious-ownership check refuses to operate — --system writes
# /etc/gitconfig, applied to all users including semiont.
RUN apk add --no-cache git && \
    git config --system --add safe.directory /kb

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 semiont

# The global @semiont/make-meaning + neo4j-driver (with hoisted deps) and bins.
COPY --from=installer /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=installer /usr/local/bin /usr/local/bin

# Strip npm/npx (re-introduced by the COPY above) plus the TypeScript compiler.
# `typescript` + its native `@typescript/*` Go binaries are pulled transitively
# via the qdrant client's dep chain but never loaded at runtime — build-only
# baggage, and the native `tsc` carries a Go-stdlib CVE (CVE-2026-39822).
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx && \
    find /usr/local/lib/node_modules \
      -type d \( -name typescript -o -name '@typescript' \) -prune -exec rm -rf {} +

COPY LICENSE /home/semiont/LICENSE
COPY apps/archivist/NOTICE /home/semiont/NOTICE

WORKDIR /kb
RUN chown semiont:nodejs /kb
USER semiont

ENV NODE_ENV=production
# The container-side paths are constants of the image, declared here the way
# the gateway image declares them (see rootstate.go's anchored-text comment):
# the launcher mounts host dirs AT these targets and passes no path env.
ENV SEMIONT_ROOT=/kb
ENV SEMIONT_ANCHORED_TEXT_DIR=/anchored-text

# ── Heap ceiling (ARCHIVIST-STAYS-UP P4) ─────────────────────────────────
# WHY THIS EXISTS, because a bare number here is unreadable in a year:
#
# On 2026-09-03 this process died with "JavaScript heap out of memory" at
# ~1016 MB while the container was allotted 2048 MB — it never came close to
# the container's limit. V8 derives its own default old-space ceiling from
# visible memory and lands well under the cgroup allocation, so roughly half
# the memory the fleet pays for was unreachable. See
# .plans/bugs/absent-archivist-wedges-browse.md.
#
# 1536 leaves ~512 MB under the container's 2G for everything OUTSIDE the JS
# heap: RSS overhead, Buffers, the git subprocesses this image shells out to,
# and neo4j-driver's native allocations. Do not raise this to 2048 — being
# OOM-KILLED by the cgroup is strictly worse than a V8 heap error, because the
# process is shot rather than given the chance to throw and log.
#
# ⚠️ THIS NUMBER IS PAIRED with the archivist's `mem` in
# apps/launcher/internal/launcher/service.go. Changing either without the
# other silently re-opens the gap this closes. That pairing wants a gate —
# see ARCHIVIST-STAYS-UP P2, which already cross-checks Dockerfile
# declarations against launcher facts.
#
# Applies to EVERY node invocation in the container, which is intended: the
# CMD is supervise.sh, and the child it spawns is the process that needs the
# ceiling. The HEALTHCHECK's `node -e` inherits it too and does not care.
#
# VERIFY IT TOOK EFFECT: the `semiont.runtime.heap{heap.stat="limit"}` gauge
# reports V8's actual ceiling at runtime. A cap that was set but not applied
# shows up there as the old default — assume nothing.
ENV NODE_OPTIONS=--max-old-space-size=1536

EXPOSE 24103

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:24103/health', r => process.exit(r.statusCode < 400 ? 0 : 1)).on('error', () => process.exit(1))"

# The supervisor, not node directly (ARCHIVIST-STAYS-UP P1): restarts a
# crashed child, probes and kills a hung one, keeps the pre-death log on the
# state mount. No runtime restart mechanism exists on all three runtimes.
COPY apps/archivist/supervise.sh /usr/local/bin/supervise.sh
CMD ["/bin/sh", "/usr/local/bin/supervise.sh"]
