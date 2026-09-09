# node:24, not 26: node 26's built-in undici breaks the qdrant client at connect.
FROM node:24-alpine AS installer
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG SEMIONT_VERSION=latest
RUN --mount=type=cache,target=/root/.npm \
    npm config set registry $NPM_REGISTRY && \
    npm install -g npm@12.0.1 && \
    npm install @semiont/gateway@${SEMIONT_VERSION} neo4j-driver @qdrant/js-client-rest \
      --prefix /home/semiont/.local/share/semiont

RUN cd /home/semiont/.local/share/semiont/node_modules/@semiont/gateway && \
    npx prisma generate --schema=prisma/schema.prisma && \
    test -d /home/semiont/.local/share/semiont/node_modules/.prisma/client

# Self-retiring CVE patches: when a guard here fails, DELETE the entry it names.
RUN set -eu; \
    patch_dep() { \
      ROOT="$1"; PKG="$2"; WANT="$3"; \
      for p in $(find "$ROOT" -type d -path "*/node_modules/$PKG"); do \
        HAVE=$(node -pe "require('$p/package.json').version"); \
        if node -e 'const c=(a,b)=>{a=a.split(".").map(Number);b=b.split(".").map(Number);for(let i=0;i<3;i++){const d=(a[i]||0)-(b[i]||0);if(d)return d}return 0};process.exit(c(process.argv[1],process.argv[2])>=0?0:1)' "$HAVE" "$WANT"; then \
          echo "$ROOT now provides $PKG $HAVE (>= $WANT) at $p."; \
          echo "DELETE the $PKG entry from the self-retiring patch block in apps/gateway/Dockerfile."; \
          return 1; \
        fi; \
      done; \
      npm pack "$PKG@$WANT" --pack-destination /tmp >/dev/null; \
      tar -xzf "/tmp/$PKG-$WANT.tgz" -C /tmp; \
      find "$ROOT" -type d -path "*/node_modules/$PKG" \
        -exec sh -c 'rm -rf "$1" && cp -a /tmp/package "$1"' _ {} \;; \
      rm -rf "/tmp/$PKG-$WANT.tgz" /tmp/package; \
    }; \
    NPM_TREE=/usr/local/lib/node_modules/npm; \
    APP_TREE=/home/semiont/.local/share/semiont; \
    patch_dep "$NPM_TREE" brace-expansion 5.0.9; \
    patch_dep "$NPM_TREE" ip-address 10.3.1; \
    patch_dep "$NPM_TREE" tar 7.5.21; \
    patch_dep "$APP_TREE" deepmerge-ts 8.0.0

FROM node:24-alpine
ARG SEMIONT_VERSION=latest
RUN apk upgrade --no-cache && \
    apk add --no-cache git && \
    git config --system --add safe.directory /kb

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 semiont

COPY --from=installer /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=installer /usr/local/bin /usr/local/bin
COPY --from=installer --chown=semiont:nodejs /home/semiont/.local/share/semiont /home/semiont/.local/share/semiont

# mysql2 by -path, not -name: -name would also delete studio-core's data/mysql2 shim.
RUN find /usr/local/lib/node_modules /home/semiont/.local/share/semiont \
      -type d \( -name typescript -o -name '@typescript' -o -name elkjs \
                 -o -path '*/node_modules/mysql2' \) \
      -prune -exec rm -rf {} +

COPY LICENSE apps/gateway/NOTICE /home/semiont/

WORKDIR /kb
RUN chown semiont:nodejs /kb
# Supervision runtime — ROOT-TIME on purpose: apk refuses to run and
# /usr/local/bin refuses writes once USER drops privileges below.
RUN apk add --no-cache tini
COPY scripts/container/supervise.sh /usr/local/bin/supervise.sh
COPY scripts/container/boot.sh /usr/local/bin/boot.sh
COPY scripts/container/gateway-boot.sh /usr/local/bin/gateway-boot.sh

USER semiont

ENV NODE_ENV=production
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/api/health', r => process.exit(r.statusCode < 400 ? 0 : 1)).on('error', () => process.exit(1))"

ENV SEMIONT_ENV=local
ENV GATEWAY_DIR=/home/semiont/.local/share/semiont/node_modules/@semiont/gateway
ENV PATH="/home/semiont/.local/share/semiont/node_modules/.bin:${PATH}"

RUN test -f "$GATEWAY_DIR/dist/index.js" \
      || { echo "GATEWAY_DIR does not contain dist/index.js: $GATEWAY_DIR"; exit 1; }; \
    test -f "$GATEWAY_DIR/prisma/schema.prisma" \
      || { echo "no prisma schema under $GATEWAY_DIR — migrate deploy would fail at start"; exit 1; }; \
    test -d /home/semiont/.local/share/semiont/node_modules/.prisma/client \
      || { echo "generated prisma client missing from the runtime image (pruned?)"; exit 1; }; \
    test -f "$GATEWAY_DIR/dist/cli/db-url.js" \
      || { echo "@semiont/gateway@${SEMIONT_VERSION} predates dist/cli/db-url.js, which this CMD needs to derive DATABASE_URL — build with a version that ships it"; exit 1; }; \
    command -v semiont-useradd >/dev/null \
      || { echo "semiont-useradd is not on PATH — \`semiont useradd\` execs it by name; check the package's bin entry and the PATH above"; exit 1; }

ENV SUPERVISE_NAME=gateway \
    SUPERVISE_PROBE=http://localhost:4000/api/health
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/gateway-boot.sh"]
CMD ["node", "/home/semiont/.local/share/semiont/node_modules/@semiont/gateway/dist/index.js"]
