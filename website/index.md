---
layout: default
title: Semiont - Trusted AI Knowledge Bases
---

## Semiont

**Semiont turns your documents into a knowledge base that people and AI agents build together, with everything it knows pinned to the passage it came from.** Agents propose what a passage mentions, what it links to and what to make of it; people accept, correct or reject each proposal. Applications and agents built on the result can cite their sources, so their answers can be checked. It is open source, and can run entirely on your own machines.

![The Semiont browser: a document with its references highlighted, and a panel of assessments beside it](assets/images/semiont-2026-03-10.png)

- **Annotate and link documents.** Every mark is a W3C Web Annotation, an open standard, kept with your documents in a git repository you own.
- **Grow a knowledge graph.** The marks and links build a graph of the people, things and documents in your corpus. Search it by meaning, navigate it, and see who changed what, and when.
- **Serve context to AI.** Applications reach it through the [SDK](https://github.com/The-AI-Alliance/semiont/blob/main/docs/builder/README.md), in TypeScript, Rust, Python or Go, and AI assistants such as Claude through [MCP](https://github.com/The-AI-Alliance/semiont/blob/main/docs/builder/AI-APPLICATIONS.md). Its models can be hosted or run locally.

**No cold start.** Most knowledge systems are useless until someone invests weeks in schema design, taxonomy building, and manual data entry — the *cold-start problem*. Semiont skips it: import documents and AI agents immediately begin detecting entities, proposing annotations, and linking related material for humans to review and refine. The knowledge graph grows as a byproduct of that work — no upfront schema, no ETL pipeline.

## Get Started

No npm, no Node.js — the `semiont` launcher is a single static binary. You'll need a container runtime ([Apple Container](https://github.com/apple/container), [Docker](https://www.docker.com/), or [Podman](https://podman.io/)), auto-detected:

```bash
brew install the-ai-alliance/semiont/semiont
```

Homebrew serves macOS and Linux. On Windows, the [GitHub Release](https://github.com/The-AI-Alliance/semiont/releases) carries a zip holding `semiont.exe` — see [Semiont on Windows](https://github.com/The-AI-Alliance/semiont/blob/main/docs/operator/platforms/WINDOWS.md).

Configure settings. `semiont settings` lists everything the launcher keeps; the first you are likely to need is an external inference secret — unless you run a small model on your own machine with [Ollama](https://ollama.com/), which needs none. Register an [Anthropic](https://www.anthropic.com/) key once, as a pointer into your vault; only the pointer is stored, read fresh on every start and written nowhere:

```bash
semiont settings secret set ANTHROPIC_API_KEY op://YourVaultName/Anthropic/credential
```

Create a knowledge base in place and start it. Change `--domain` — it is the KB's permanent identity, stamped into the committed event log — and use `--inference ollama` if you chose the local model:

```bash
mkdir my-kb && cd my-kb
semiont init --yes --domain example.com:my-kb --inference anthropic
semiont start
```

One command brings up the whole stack from published, attested container images — including the Semiont browser. Create your admin user and sign in at **http://localhost:3000**:

```bash
semiont useradd --email admin@example.com   # prompts for the password
```

Then sign the launcher in, ingest a document, and have the stack detect references to concepts in it — the same work you and AI agents share in the browser:

```bash
semiont login          # approve in a browser; only tokens come back
mkdir -p papers
curl -L -o papers/attention-is-all-you-need.pdf https://arxiv.org/pdf/1706.03762
semiont yield --upload papers/attention-is-all-you-need.pdf   # prints the resource id
semiont mark --delegate <resourceId> --motivation linking --entity-type Concept
```

The **[Quick Start](https://github.com/The-AI-Alliance/semiont/blob/main/docs/builder/QUICK-START.md)** walks through each step.

### Or start with content already in place

Clone a knowledge base instead of creating one — it arrives with its identity and configs set, so `semiont init` is not needed. A plain `semiont start` runs its local Ollama config; add `--config anthropic` to run on the key you registered:

```bash
git clone https://github.com/The-AI-Alliance/semiont-gutenberg-kb.git
cd semiont-gutenberg-kb
semiont start
```

- **[semiont-gutenberg-kb](https://github.com/The-AI-Alliance/semiont-gutenberg-kb)** — Public-domain literature from Project Gutenberg
- **[semiont-template-kb](https://github.com/The-AI-Alliance/semiont-template-kb)** — Empty template, if you would rather fork than `init`
- **[Full catalog](https://github.com/The-AI-Alliance/semiont/blob/main/docs/KNOWLEDGE-BASES.md)** — seven demo KBs across different domains, plus community knowledge bases

## How it works

Humans and AI agents are architectural equals: every operation — whether it comes from the GUI, the [TypeScript](https://github.com/The-AI-Alliance/semiont/tree/main/packages/typescript/sdk), [Rust](https://github.com/The-AI-Alliance/semiont/tree/main/packages/rust/sdk), [Python](https://github.com/The-AI-Alliance/semiont/tree/main/packages/python/sdk) or [Go](https://github.com/The-AI-Alliance/semiont/tree/main/packages/go/sdk) SDK, [agent skills](https://github.com/The-AI-Alliance/semiont/tree/main/docs/builder/skills), or the [`semiont` launcher](https://github.com/The-AI-Alliance/semiont/tree/main/apps/launcher) — travels the same event bus, speaking the same **[eight verbs](https://github.com/The-AI-Alliance/semiont/blob/main/docs/protocol/flows/README.md)**: four that write (*yield, mark, bind, frame*), three that read (*browse, match, gather*), and one that directs attention (*beckon*). Any workflow can be done manually, automated by an agent, or shared between the two. The **[protocol docs](https://github.com/The-AI-Alliance/semiont/tree/main/docs/protocol)** cover the design in depth.

## Open Source & Community

[![License](https://img.shields.io/github/license/The-AI-Alliance/semiont)](https://github.com/The-AI-Alliance/semiont/tree/main?tab=Apache-2.0-1-ov-file#readme)
[![GitHub stars](https://img.shields.io/github/stars/The-AI-Alliance/semiont?style=social)](https://github.com/The-AI-Alliance/semiont/stargazers)

Semiont is Apache 2.0 licensed and developed in the open. We welcome contributions from the community.

- **[View on GitHub](https://github.com/The-AI-Alliance/semiont)** — Explore the source code and documentation

---

**Part of the [AI Alliance](https://thealliance.ai/) — building open, safe, and beneficial AI for everyone.**
