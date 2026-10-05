# archivist image.
#
# THE ENTRYPOINT SOURCE IS NOT IN THIS DIRECTORY. This image installs the
# published @semiont/make-meaning and runs `dist/archivist-main.js` out of it; the
# source is packages/make-meaning/src/archivist/archivist-main.ts. If you change
# the CMD, change it against that file. The CMD passes the path of the
# configuration document (ArchivistConfig in specs/), which whoever runs the
# image mounts there.
#
# Stage 1: install (npm runs here, then is discarded).
#
# The Archivist is a separate image from the shared @semiont/make-meaning
# package, like smelter and weaver — separate because their dependency
# footprints differ. The Archivist dials no graph and no vector store, so it
# installs no driver beside the package.
#
# Base is node:24-alpine (not node:26): node 26's built-in undici breaks the
# qdrant client's own undici, which @semiont/make-meaning can load transitively
# at connect time.
FROM node:24-alpine AS installer
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG SEMIONT_VERSION=latest
# @qdrant/js-client-rest pins undici exactly; `npm install -g` ignores overrides,
# so the pinned copy is replaced after install. See the script.
COPY scripts/container/patch-qdrant-undici.sh /tmp/patch-qdrant-undici.sh
RUN npm config set registry $NPM_REGISTRY && \
    npm install -g @semiont/make-meaning@${SEMIONT_VERSION} && \
    sh /tmp/patch-qdrant-undici.sh && \
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
# single git writer. smelter/weaver carry no git; this image must. Same as the
# gateway image: when the mounted KB is owned by a host UID that differs from
# the in-container semiont user (UID 1001), git's CVE-2022-24765
# dubious-ownership check refuses to operate — --system writes /etc/gitconfig,
# applied to all users including semiont.
RUN apk add --no-cache git && \
    git config --system --add safe.directory /kb

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 semiont

# The global @semiont/make-meaning (with hoisted deps) and bins.
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
# Supervision runtime — ROOT-TIME on purpose: apk refuses to run and
# /usr/local/bin refuses writes once USER drops privileges below.
RUN apk add --no-cache tini
COPY scripts/container/supervise.sh /usr/local/bin/supervise.sh
COPY scripts/container/boot.sh /usr/local/bin/boot.sh

USER semiont

ENV NODE_ENV=production

# ── Heap ceiling ─────────────────────────────────────────────────────────
# WHY THIS EXISTS, because a bare number here is unreadable in a year:
#
# V8 derives its own default old-space ceiling from visible memory and lands
# well under the cgroup allocation: allotted 2048 MB, this process dies with
# "JavaScript heap out of memory" at ~1016 MB, nowhere near the container's
# limit, so without a ceiling of its own roughly half the memory the fleet
# pays for is unreachable.
#
# 1536 leaves ~512 MB under the container's 2G for everything OUTSIDE the JS
# heap: RSS overhead, Buffers and the git subprocesses this image shells out
# to. Do not raise this to 2048 — being
# OOM-KILLED by the cgroup is strictly worse than a V8 heap error, because the
# process is shot rather than given the chance to throw and log.
#
# ⚠️ THIS NUMBER IS PAIRED with the archivist's `mem` in
# apps/launcher/internal/launcher/descriptors.go. Changing either without the
# other silently re-opens the gap this closes. That pairing wants a gate —
# its natural home is the launcher test that already cross-checks each
# service's Dockerfile declarations against launcher facts
# (TestServiceHealthPortsAgreeAcrossAllHomes).
#
# Applies to EVERY node invocation in the container, which is intended: the
# CMD is the process that needs the ceiling, whether boot.sh runs it directly
# or under supervise.sh. The HEALTHCHECK's `node -e` inherits it too and does
# not care.
#
# VERIFY IT TOOK EFFECT: the `semiont.runtime.heap{heap.stat="limit"}` gauge
# reports V8's actual ceiling at runtime. A cap that was set but not applied
# shows up there as V8's own default — assume nothing.
ENV NODE_OPTIONS=--max-old-space-size=1536

EXPOSE 24103

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:24103/health', r => process.exit(r.statusCode < 400 ? 0 : 1)).on('error', () => process.exit(1))"

ENV SUPERVISE_NAME=archivist \
    SUPERVISE_PROBE=http://localhost:24103/health
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/boot.sh"]
CMD ["node", "/usr/local/lib/node_modules/@semiont/make-meaning/dist/archivist-main.js", "--config", "/etc/semiont/archivist.json"]
