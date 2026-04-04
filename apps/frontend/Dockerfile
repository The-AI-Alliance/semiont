FROM node:22-alpine

RUN apk add --no-cache curl
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm config set registry $NPM_REGISTRY && \
    npm install -g @semiont/cli && \
    npm cache clean --force

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 semiont

WORKDIR /app
RUN chown semiont:nodejs /app

USER semiont

RUN cat <<'EOF' > /home/semiont/.semiontconfig
[user]
name = "semiont"
email = ""

[defaults]
environment = "local"

[environments.local.frontend]
platform = "posix"
port = 3000
publicURL = "http://localhost:3000"
EOF

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1

CMD semiont provision --verbose --service frontend && \
    semiont start --verbose -s frontend && \
    tail -f /home/semiont/.local/state/semiont/frontend/app.log
