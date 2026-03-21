# Adding and Managing Environments in Semiont CLI

Environments are named sections in `~/.semiontconfig` that configure Semiont for a specific deployment context (local, staging, production, etc.).

## Overview

- **Configuration lives in `~/.semiontconfig`** — never committed to version control
- **The project anchor is `.semiont/config`** — contains only the project name, committed to version control
- **Environment selection**: `--environment` flag, `SEMIONT_ENV`, or `defaults.environment` in `~/.semiontconfig`

## Adding a New Environment

Add a new `[environments.<name>.*]` set of sections to `~/.semiontconfig`:

```toml
[environments.staging.backend]
port = 3001
publicURL = "https://api.staging.example.com"
frontendURL = "https://staging.example.com"
corsOrigin = "https://staging.example.com"

[environments.staging.site]
domain = "staging.example.com"
siteName = "Semiont (staging)"
adminEmail = "admin@example.com"
oauthAllowedDomains = ["example.com"]

[environments.staging.database]
host = "staging-db.example.com"
port = 5432
name = "semiont_staging"
user = "semiont"
password = "${STAGING_DB_PASSWORD}"

[environments.staging.make-meaning.graph]
type = "neo4j"
uri = "bolt://staging-neo4j.example.com:7687"
username = "neo4j"
password = "${NEO4J_PASSWORD}"

[environments.staging.workers.default.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"
maxTokens = 4096
apiKey = "${ANTHROPIC_API_KEY}"
```

Then use it:

```bash
semiont provision --environment staging
semiont start --environment staging
semiont check --environment staging
```

## Environment Sections

Each environment can include:

| Section | Purpose |
|---|---|
| `[environments.<env>.backend]` | Backend port, public URL, CORS origin |
| `[environments.<env>.site]` | Domain, OAuth allowed domains, site name |
| `[environments.<env>.database]` | PostgreSQL connection settings |
| `[environments.<env>.make-meaning.graph]` | Graph database (memory, neo4j) |
| `[environments.<env>.make-meaning.actors.<name>.inference]` | Per-actor inference (gatherer, matcher) |
| `[environments.<env>.workers.default.inference]` | Default inference for all workers |
| `[environments.<env>.workers.<name>.inference]` | Per-worker inference override |
| `[environments.<env>.ollama]` | Ollama server settings (when using local LLM) |

See [Configuration Guide](../../../docs/administration/CONFIGURATION.md) for the complete schema and all options.

## Setting a Default Environment

```toml
[defaults]
environment = "local"
```

With this set, `semiont start` uses `local` without needing `--environment` or `SEMIONT_ENV`.

## Environment Variables in Config

Use `${VAR_NAME}` syntax to reference environment variables — useful for secrets:

```toml
[environments.local.database]
password = "${POSTGRES_PASSWORD}"

[environments.local.workers.default.inference]
apiKey = "${ANTHROPIC_API_KEY}"
```

These are resolved from `process.env` at config load time.

## Testing Configuration

```bash
# Validate that a service starts correctly
semiont check --environment staging

# Dry run
semiont provision --environment staging --dry-run
```

## CI/CD Integration

```yaml
# .github/workflows/deploy.yml
env:
  SEMIONT_ENV: ${{ github.ref == 'refs/heads/main' && 'production' || 'staging' }}

steps:
  - run: semiont deploy all
```

The `~/.semiontconfig` on the CI runner must have the appropriate environment sections configured (or injected via environment variables).
