# Semiont

**Semiont is an open, source-grounded semantic knowledge platform for building and maintaining trusted AI knowledge bases and context layers. It gives humans and AI agents a shared workspace and architecture to annotate, connect, enrich, and govern domain knowledge for accurate applications, agents, and workflows.**

![Semiont screenshot](website/assets/images/semiont-2026-03-10.png)

## Quick Start

You don't run Semiont from this repository. **This repo is the platform source** — it publishes the npm packages and the container images. You run Semiont from a **knowledge-base repo**: a separate, small repository holding your documents, configuration, and startup scripts, whose stack *pulls* the published, attested `ghcr.io/the-ai-alliance/semiont-*` images (KB repos build no images of their own).

Three steps: clone a KB repo → start it → connect.

### 1. Clone a knowledge-base repo

Not this repo — one of these:

**Try a demo** — [semiont-gutenberg-kb](https://github.com/The-AI-Alliance/semiont-gutenberg-kb), public-domain literature from Project Gutenberg:

```bash
git clone https://github.com/The-AI-Alliance/semiont-gutenberg-kb.git
```

**Start a new project** — [semiont-template-kb](https://github.com/The-AI-Alliance/semiont-template-kb), the empty template:

```bash
git clone https://github.com/The-AI-Alliance/semiont-template-kb.git
```

The full catalog — seven demo KBs across different domains, plus community
knowledge bases — is in **[docs/KNOWLEDGE-BASES.md](docs/KNOWLEDGE-BASES.md)**.

### 2. Start it

Install one of [Apple Container](https://github.com/apple/container), [Docker](https://www.docker.com/), or [Podman](https://podman.io/) if you don't already have one. Then `cd` into the KB repo you just cloned — **not this repo** — and run:

```bash
.semiont/scripts/start.sh --email admin@example.com --password <choose-a-password>
```

One script starts the whole stack: it pulls the published Semiont images and the infrastructure containers, bind-mounts the KB's config, and brings everything up — **including the Semiont browser at http://localhost:3000**. The `--email`/`--password` you pass create the admin user you'll sign in with. See the KB's own README for prerequisites and options (inference configs, `--list-configs`, etc.).

### 3. Connect

Open **http://localhost:3000**. In the Semiont browser's Knowledge Bases panel, enter host `localhost`, port `4000`, and the email and password from step 2.

![Connect to knowledge base](website/assets/images/connect-kb.png)

**Just the browser?** To point a Semiont browser at an already-running or remote knowledge base without cloning anything, run the published image directly (substitute `docker` or `podman` for `container` as needed):

```bash
container run --publish 3000:3000 -it ghcr.io/the-ai-alliance/semiont-frontend:latest
```

For local-network access notes, supply-chain verification, the native [desktop app](https://github.com/The-AI-Alliance/semiont/releases) alternative, and frontend dev setup, see **[docs/browser/](docs/browser/README.md)**.

## Automate

Every operation in the GUI is available programmatically through three surfaces:

- **[Semiont SDK](packages/sdk/README.md)** — type-safe TypeScript client (`@semiont/sdk`) for scripts, embeddings, and apps.
- **[Semiont CLI](apps/cli/README.md)** — drive Semiont from the terminal.
- **[Agent Skills](docs/protocol/skills/)** — ready-made skill definitions for agentic coding assistants like Claude Code.

All three are organized around **[eight composable flows](docs/protocol/flows/README.md)** — frame, yield, mark, match, bind, gather, browse, beckon — the same verbs whether driven by a human, a script, or an AI agent. See **[docs/protocol/](docs/protocol/README.md)** for the protocol overview, design tenets, and value proposition.

## Contributing

> ⚠️ **Alpha.** API and package surface are not yet stable; breaking changes between 0.x releases are expected.

[![CI](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml?query=branch%3Amain)
[![License](https://img.shields.io/github/license/The-AI-Alliance/semiont)](https://github.com/The-AI-Alliance/semiont/tree/main?tab=Apache-2.0-1-ov-file#readme)
[![Issues](https://img.shields.io/github/issues/The-AI-Alliance/semiont)](https://github.com/The-AI-Alliance/semiont/issues)

- **[Development docs](docs/development/README.md)** — codebase layout, build status badges, Codespaces shortcut, where to read next.
- **[System architecture](docs/system/README.md)** — actor model, knowledge system, container topology, package architecture.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — branch/PR workflow, commit conventions, platform-contribution playbook.

## 📜 License

Apache 2.0 - See [LICENSE](LICENSE) for details.
