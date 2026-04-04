FROM node:22-alpine

RUN apk add --no-cache git curl
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm config set registry $NPM_REGISTRY && \
    npm install -g @semiont/cli neo4j-driver && \
    npm cache clean --force

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 semiont

WORKDIR /kb
RUN chown semiont:nodejs /kb

USER semiont

RUN cat <<'EOF' > /home/semiont/.semiontconfig
[user]
name = ""
email = ""

[defaults]
environment = "local"

[environments.local.backend]
platform = "posix"
port = 4000
publicURL = "http://localhost:4000"

[environments.local.graph]
platform = "external"
type = "neo4j"
name = "neo4j"
uri = "${NEO4J_URI}"
username = "${NEO4J_USERNAME}"
password = "${NEO4J_PASSWORD}"
database = "${NEO4J_DATABASE}"

[environments.local.inference.anthropic]
platform = "external"
endpoint = "https://api.anthropic.com"
apiKey = "${ANTHROPIC_API_KEY}"

[environments.local.actors.gatherer.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

[environments.local.actors.matcher.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

[environments.local.workers.default.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

[environments.local.workers.reference-annotation.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

[environments.local.workers.highlight-annotation.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"

[environments.local.workers.assessment-annotation.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

[environments.local.workers.comment-annotation.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"

[environments.local.workers.tag-annotation.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"

[environments.local.workers.generation.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

[environments.local.database]
platform = "external"
host = "${POSTGRES_HOST}"
port = 5432
name = "semiont"
user = "postgres"
password = "localpass"
EOF

ENV NODE_ENV=production
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:4000/api/health || exit 1

CMD semiont serve --verbose && \
    tail -f /home/semiont/.local/state/semiont/app/backend/app.log
