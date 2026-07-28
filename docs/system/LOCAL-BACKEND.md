# Local Backend Setup

Run the Semiont backend locally. Inference providers, database credentials, graph, and vector store settings all come from the KB's own `.semiont/semiontconfig/<name>.toml` — see the **[Configuration Guide](./administration/CONFIGURATION.md)**.

For a stack on GitHub's machine rather than your own, the launcher's codespace placement (`semiont start --runtime codespace`) is covered in **[Knowledge Bases](../KNOWLEDGE-BASES.md)**.

## Running the stack

Install the [`semiont` launcher](../../apps/launcher/README.md)
(`brew install the-ai-alliance/semiont/semiont`), clone a knowledge base
repository, and start the stack:

```bash
git clone https://github.com/The-AI-Alliance/gutenberg-kb.git
cd gutenberg-kb
semiont start
echo password | semiont useradd --email admin@example.com --admin
```

The launcher pulls the published, attested Semiont service images
(`ghcr.io/the-ai-alliance/semiont-{backend,worker,smelter,weaver,frontend}`),
starts them alongside the infrastructure containers (Neo4j, Qdrant,
PostgreSQL), and bind-mounts the KB's config at runtime — KB repos build no
images. Nothing auto-creates an account: `semiont useradd` makes the first
admin (and every user after), prompting for the password rather than taking
it as an argument. `--config <name>` selects an inference config (`--list-configs` to see them);
`SEMIONT_VERSION` pins the image version (`local` consumes images built from
a monorepo working tree by
[`scripts/ci/local-build.sh`](../../scripts/ci/local-build.sh)). `semiont
status` / `logs` / `stop` manage the running stack.

Prerequisites: a container runtime, plus `ANTHROPIC_API_KEY` when using the
Anthropic config. See the [KB README](https://github.com/The-AI-Alliance/gutenberg-kb) for details.

The authoritative compose files and inference presets live in the [semiont-template-kb](https://github.com/The-AI-Alliance/semiont-template-kb) template repository under `.semiont/`; the image inventory and supply-chain verification are in [Container Images](./administration/IMAGES.md).

## Ports

| Service | Port | URL |
|---------|------|-----|
| Backend | 4000 | http://localhost:4000 |
| PostgreSQL | 5432 | postgresql://localhost:5432 |
| Neo4j | 7687 | bolt://localhost:7687 |
| Qdrant | 6333 | http://localhost:6333 |

## Paths

| Path | Contents |
|------|----------|
| `.semiont/semiontconfig/<name>.toml` | Environment config: inference, database, graph credentials (committed; the launcher stages a copy and mounts it into each service at `~/.semiontconfig`) |
| `.semiont/config` | Project anchor: KB name and `did:web` site identity (committed) |
| `.semiont/events/` | The event log — system of record (committed) |

Service logs go to stdout — `semiont logs`. Database, graph, and vector data live in the container
volumes the launcher manages; `semiont clean` removes them.
