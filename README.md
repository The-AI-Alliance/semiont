# Semiont

**Semiont is an open, source-grounded semantic knowledge platform for building and maintaining trusted AI knowledge bases and context layers. It gives humans and AI agents a shared workspace and architecture to annotate, connect, enrich, and govern domain knowledge for accurate applications, agents, and workflows.**

![Semiont screenshot](website/assets/images/semiont-2026-03-10.png)

## Quick Start

### Start the browser

Install one of [Apple Container](https://github.com/apple/container), [Docker](https://www.docker.com/), or [Podman](https://podman.io/) if you don't already have one.

Run the published browser container image (substitute `docker` or `podman` for `container` as needed):

```bash
container run --publish 3000:3000 -it ghcr.io/the-ai-alliance/semiont-frontend:latest
```

Then open **http://localhost:3000** in your web browser.

For local-network access notes, supply-chain verification, the native [desktop app](https://github.com/The-AI-Alliance/semiont/releases) alternative, and frontend dev setup, see **[docs/browser/](docs/browser/README.md)**.

### Start a knowledge base

Clone a knowledge base and follow its README. Each KB repo contains configuration, compose files, and startup scripts under `.semiont/` — the stack pulls the published, attested `ghcr.io/the-ai-alliance/semiont-*` images and bind-mounts the KB's config at runtime (KBs build no images of their own).

#### Starting from scratch

| Template | Description |
|---|---|
| **[semiont-template-kb](https://github.com/The-AI-Alliance/semiont-template-kb)** | Empty template — start here for a new project |

#### Demo KBs

These ship a small corpus and a layered set of skills (ingest → mark → canonicalize → wire-edges → compose-aggregates) that demonstrate the SDK in a particular domain. The value is the *skills*, not the data — the skills are corpus-generic and work on any corpus dropped into the same directory layout.

| Knowledge Base | Domain |
|---|---|
| **[semiont-gutenberg-kb](https://github.com/The-AI-Alliance/semiont-gutenberg-kb)** | Public-domain literature from Project Gutenberg |
| **[semiont-arxiv-kb](https://github.com/The-AI-Alliance/semiont-arxiv-kb)** | Research papers from arXiv |
| **[semiont-legal-kb](https://github.com/The-AI-Alliance/semiont-legal-kb)** | Synthetic legal documents — contracts, attorney correspondence, internal memos |
| **[semiont-caselaw-kb](https://github.com/The-AI-Alliance/semiont-caselaw-kb)** | U.S. case law — Supreme Court opinions and state appellate cases |
| **[semiont-clinical-evidence-kb](https://github.com/The-AI-Alliance/semiont-clinical-evidence-kb)** | Synthetic clinical evidence — trials, observational studies, treatment guidelines, drug-safety reports |
| **[semiont-newsroom-kb](https://github.com/The-AI-Alliance/semiont-newsroom-kb)** | Synthetic investigative-journalism documents — interview transcripts, FOIA responses, public statements |
| **[semiont-household-kb](https://github.com/The-AI-Alliance/semiont-household-kb)** | Synthetic home-property records — service receipts, contractor emails, manuals, mortgage / insurance, HOA notices |

#### Community

| Knowledge Base | Domain |
|---|---|
| **[synthetic-family](https://github.com/pingel-org/synthetic-family)** | Synthetic family history and genealogy |

### Connect browser to knowledge base

In the Semiont browser's Knowledge Bases panel, enter host `localhost`, port `4000`, and the email and password you provided when starting the backend.

![Connect to knowledge base](website/assets/images/connect-kb.png)

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
