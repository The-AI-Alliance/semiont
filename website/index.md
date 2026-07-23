---
layout: default
title: Semiont - Trusted AI Knowledge Bases
---

## Semiont

**Semiont is an open, source-grounded platform for building trusted AI knowledge bases — a shared workspace where humans and AI agents annotate, connect, and govern domain knowledge.**

![Semiont screenshot](assets/images/semiont-2026-03-10.png)

- **Annotate and link documents.** Humans and AI agents mark entities, comments, and references directly in your corpus — every annotation anchors to a specific passage, in the W3C Web Annotation standard.
- **Grow a grounded knowledge graph.** Annotations and links project into a graph where every node traces back to its source. Search it semantically, navigate it, audit its provenance.
- **Serve trusted context to AI.** Feed RAG pipelines, agents, and applications from cited sources instead of unchecked generation. Self-hosted, with inference on [Anthropic](https://www.anthropic.com/) (cloud) or [Ollama](https://ollama.com/) (fully local).

**No cold start.** Most knowledge systems are useless until someone invests weeks in schema design, taxonomy building, and manual data entry — the *cold-start problem*. Semiont skips it: import documents and AI agents immediately begin detecting entities, proposing annotations, and linking related material for humans to review and refine. The knowledge graph grows as a byproduct of that work — no upfront schema, no ETL pipeline.

## Get Started

Three steps — no npm or Node.js required. Install the `semiont` launcher (a single static binary) and a container runtime ([Apple Container](https://github.com/apple/container), [Docker](https://www.docker.com/), or [Podman](https://podman.io/)):

```bash
brew install the-ai-alliance/semiont/semiont
```

Clone a knowledge-base repo — the empty template for a new project (or birth one in place with `semiont init`), or a pre-populated demo — and start it:

```bash
git clone https://github.com/The-AI-Alliance/semiont-gutenberg-kb.git
cd semiont-gutenberg-kb
semiont start
```

One command brings up the whole stack from published, attested container images — including the Semiont browser. Create your admin user and sign in at **http://localhost:3000**:

```bash
semiont useradd --email admin@example.com --password <choose-a-password> --admin
```

Explore the knowledge bases:

- **[semiont-template-kb](https://github.com/The-AI-Alliance/semiont-template-kb)** — Empty template; start here for a new project
- **[semiont-gutenberg-kb](https://github.com/The-AI-Alliance/semiont-gutenberg-kb)** — Public-domain literature from Project Gutenberg
- **[Full catalog](https://github.com/The-AI-Alliance/semiont/blob/main/docs/KNOWLEDGE-BASES.md)** — seven demo KBs across different domains, plus community knowledge bases

See the **[Quick Start](https://github.com/The-AI-Alliance/semiont#quick-start)** for full setup instructions.

## How it works

Humans and AI agents are architectural equals: every operation — whether it comes from the GUI, the [TypeScript SDK](https://github.com/The-AI-Alliance/semiont/tree/main/packages/sdk), [agent skills](https://github.com/The-AI-Alliance/semiont/tree/main/docs/protocol/skills), or the [CLI](https://github.com/The-AI-Alliance/semiont/tree/main/apps/cli) — travels the same event bus, speaking the same **[eight verbs](https://github.com/The-AI-Alliance/semiont/blob/main/docs/protocol/flows/README.md)**: *frame, yield, mark, match, bind, gather, browse, beckon*. Any workflow can be done manually, automated by an agent, or shared between the two. The **[protocol docs](https://github.com/The-AI-Alliance/semiont/tree/main/docs/protocol)** cover the design in depth.

## Open Source & Community

[![License](https://img.shields.io/github/license/The-AI-Alliance/semiont)](https://github.com/The-AI-Alliance/semiont/tree/main?tab=Apache-2.0-1-ov-file#readme)
[![GitHub stars](https://img.shields.io/github/stars/The-AI-Alliance/semiont?style=social)](https://github.com/The-AI-Alliance/semiont/stargazers)

Semiont is Apache 2.0 licensed and developed in the open. We welcome contributions from the community.

- **[View on GitHub](https://github.com/The-AI-Alliance/semiont)** — Explore the source code and documentation

---

**Part of the [AI Alliance](https://thealliance.ai/) — building open, safe, and beneficial AI for everyone.**
