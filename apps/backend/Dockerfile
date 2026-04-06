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
uri = "bolt://${NEO4J_HOST}:7687"
username = "neo4j"
password = "localpass"
database = "neo4j"

[environments.local.vectors]
type = "qdrant"
host = "${QDRANT_HOST}"
port = 6333

[environments.local.vectors.embedding]
type = "ollama"
model = "nomic-embed-text"
baseURL = "http://${OLLAMA_HOST}:11434"
# To use Voyage AI instead:
# type = "voyage"
# model = "voyage-3"
# apiKey = "<your-voyage-api-key>"

[environments.local.vectors.chunking]
chunkSize = 512
overlap = 64

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

CMD semiont provision --service backend --verbose && \
    semiont start --service backend --verbose && \
    if [ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASSWORD" ]; then \
      semiont useradd --email "$ADMIN_EMAIL" --password "$ADMIN_PASSWORD" --admin --upsert; \
    fi && \
    tail -f /home/semiont/.local/state/semiont/*/backend/app.log
