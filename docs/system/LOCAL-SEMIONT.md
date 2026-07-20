# Local Semiont

Run Semiont locally. (Don't want the stack on your own machine? The same
launcher can place it in a GitHub Codespace instead — see
[Knowledge Bases](../KNOWLEDGE-BASES.md).)

There are two ways to start:

First, install the [`semiont` launcher](../../apps/launcher/README.md) — a
single static binary that drives your container runtime:

```bash
brew install the-ai-alliance/semiont/semiont
```

**Use an existing knowledge base** — clone a KB repository that already has documents and configuration (full catalog: [Knowledge Bases](../KNOWLEDGE-BASES.md)):

```bash
git clone https://github.com/The-AI-Alliance/gutenberg-kb.git
cd gutenberg-kb
semiont start
semiont useradd --email admin@example.com --password password --admin
```

One command starts the whole stack — the five published Semiont images
(backend, worker, smelter, weaver, frontend) pulled from
`ghcr.io/the-ai-alliance/*` plus the infrastructure containers — with the
KB's config bind-mounted at runtime. No npm required, and nothing is built
locally: KB repos carry no Dockerfiles and no scripts. `semiont logs`
follows the services, `semiont status` health-checks them, `semiont stop`
tears the stack down, and `semiont start --dry-run` prints the exact
runtime commands a real run would execute. See the
[KB README](https://github.com/The-AI-Alliance/gutenberg-kb) for
prerequisites and details; the image inventory is in
[Container Images](./administration/IMAGES.md).

**Create a new knowledge base** — start from the template:

```bash
git clone https://github.com/The-AI-Alliance/semiont-template-kb.git my-kb
cd my-kb
```

Start the stack with Ollama for fully local inference (no API key needed):

```bash
semiont start
semiont useradd --email admin@example.com --password password --admin
```

On first run, the backend container pulls the inference and embedding models from Ollama. This is a one-time download (~2-4 GB depending on the model) and may take several minutes.

To use Anthropic cloud inference instead:

```bash
export ANTHROPIC_API_KEY=<your-api-key>
semiont start --config anthropic
```

To see all available configs:

```bash
semiont start --list-configs
```

The stack includes the Semiont browser (the frontend container on port
3000) — no second terminal needed. To run just a browser against an
already-running KB, the published image works standalone:

```bash
container run --publish 3000:3000 -it ghcr.io/the-ai-alliance/semiont-frontend:latest
```

Want to verify image provenance before running? See [Supply-chain verification](./administration/IMAGES.md#supply-chain-verification).

**Running from source instead of published images:** build all five images
from a monorepo working tree with
[`scripts/ci/local-build.sh`](../../scripts/ci/local-build.sh) (they get the
local-only `:local` tag, never pushed, and are loaded into every container
engine on the machine — any `--runtime` can run them), then start the KB stack
with `SEMIONT_VERSION=local semiont start …` — the `local` version skips the
registry pull.

Open **http://localhost:3000** and enter **http://localhost:4000** as the knowledge base URL.

## Local network access

The browser container must be allowed to talk to the backend running on your host. Each platform handles this differently:

- **macOS + Apple `container`:** the first run prompts for permission. If you dismiss it, enable it under **System Settings → Privacy & Security → Local Network** and tick `container-runtime-linux`.
- **macOS + Docker Desktop / Podman:** the same prompt appears, granted to `com.docker.backend` or `podman-mac-helper` in the same panel.
- **Linux:** no prompt; containers share the host network namespace by default.
- **Windows:** Docker Desktop / Podman handle this via WSL2; no extra step.

## Desktop app

As an alternative to the container image, Semiont ships a native desktop app for macOS and Linux — no container runtime to install and no local network permission to grant. See [apps/desktop/README.md](../../apps/desktop/README.md) for download links, per-platform install notes, and the macOS Gatekeeper workaround.

## Detailed Setup

- **[Backend](./LOCAL-BACKEND.md)** — PostgreSQL, inference, Neo4j, service management
- **[Browser](../browser/LOCAL.md)** — SPA, desktop app, connecting to a backend

## Service Ports

| Service | Port | URL |
|---------|------|-----|
| Backend | 4000 | http://localhost:4000 |
| Browser | 3000 | http://localhost:3000 |
| PostgreSQL | 5432 | postgresql://localhost:5432 |

## Related Documentation

- [Project Layout](./PROJECT-LAYOUT.md) — Directory structure, XDG paths, and git integration
- [Configuration Guide](./administration/CONFIGURATION.md) — Full configuration reference
- [Services Overview](./services/OVERVIEW.md) — Service catalog and runtime layout
- [Knowledge Bases](../KNOWLEDGE-BASES.md) — KB repos, and running a stack in a GitHub Codespace instead of locally
- [`semiont` launcher](../../apps/launcher/README.md) — every flag, the stack record, secret sources, codespace placement
