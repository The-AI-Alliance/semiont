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

No npm, no Node.js — the `semiont` launcher is a single static binary. You'll need a container runtime ([Apple Container](https://github.com/apple/container), [Docker](https://www.docker.com/), or [Podman](https://podman.io/)), auto-detected:

```bash
brew install the-ai-alliance/semiont/semiont
```

Point it at a model. Register an [Anthropic](https://www.anthropic.com/) key once — only the pointer is stored, read fresh on every start and written nowhere — or skip this entirely and run a small model on your own machine with [Ollama](https://ollama.com/):

```bash
semiont secret set ANTHROPIC_API_KEY op://YourVaultName/Anthropic/credential
```

Birth a knowledge base in place and start it. Change `--domain` — it is the KB's permanent identity, stamped into the committed event log — and use `--inference ollama` if you chose the local model:

```bash
mkdir my-kb && cd my-kb
semiont init --yes --domain example.com:my-kb --inference anthropic
semiont start
```

One command brings up the whole stack from published, attested container images — including the Semiont browser. Create your admin user and sign in at **http://localhost:3000**:

```bash
semiont useradd --email admin@example.com   # prompts for the password
```

From there you ingest a document and start marking it up alongside AI agents working the same corpus. The **[Quick Start](https://github.com/The-AI-Alliance/semiont#quick-start)** carries it through end to end.

### Or start with content already in place

Clone a knowledge base instead of creating one — it arrives with its identity and config set, so `semiont init` is not needed:

```bash
git clone https://github.com/The-AI-Alliance/semiont-gutenberg-kb.git
cd semiont-gutenberg-kb
semiont start
```

- **[semiont-gutenberg-kb](https://github.com/The-AI-Alliance/semiont-gutenberg-kb)** — Public-domain literature from Project Gutenberg
- **[semiont-template-kb](https://github.com/The-AI-Alliance/semiont-template-kb)** — Empty template, if you would rather fork than `init`
- **[Full catalog](https://github.com/The-AI-Alliance/semiont/blob/main/docs/KNOWLEDGE-BASES.md)** — seven demo KBs across different domains, plus community knowledge bases

## How it works

Humans and AI agents are architectural equals: every operation — whether it comes from the GUI, the [TypeScript SDK](https://github.com/The-AI-Alliance/semiont/tree/main/packages/sdk), [agent skills](https://github.com/The-AI-Alliance/semiont/tree/main/docs/protocol/skills), or the [`semiont` launcher](https://github.com/The-AI-Alliance/semiont/tree/main/apps/launcher) — travels the same event bus, speaking the same **[eight verbs](https://github.com/The-AI-Alliance/semiont/blob/main/docs/protocol/flows/README.md)**: *browse, bind, yield, mark, frame, gather, match, beckon*. Any workflow can be done manually, automated by an agent, or shared between the two. The **[protocol docs](https://github.com/The-AI-Alliance/semiont/tree/main/docs/protocol)** cover the design in depth.

## Open Source & Community

[![License](https://img.shields.io/github/license/The-AI-Alliance/semiont)](https://github.com/The-AI-Alliance/semiont/tree/main?tab=Apache-2.0-1-ov-file#readme)
[![GitHub stars](https://img.shields.io/github/stars/The-AI-Alliance/semiont?style=social)](https://github.com/The-AI-Alliance/semiont/stargazers)

Semiont is Apache 2.0 licensed and developed in the open. We welcome contributions from the community.

- **[View on GitHub](https://github.com/The-AI-Alliance/semiont)** — Explore the source code and documentation

---

**Part of the [AI Alliance](https://thealliance.ai/) — building open, safe, and beneficial AI for everyone.**
