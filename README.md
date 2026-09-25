# Semiont

**Semiont is an open, source-grounded semantic knowledge platform for building and maintaining trusted AI knowledge bases and context layers. It gives humans and AI agents a shared workspace and architecture to annotate, connect, enrich, and govern domain knowledge for accurate applications, agents, and workflows.**

![Semiont screenshot](website/assets/images/semiont-2026-03-10.png)

## Quick Start

Four steps: install → get a knowledge base → start it → connect.

### 1. Install

The `semiont` launcher is a single static binary — no npm, no Node.js:

```bash
brew install the-ai-alliance/semiont/semiont
```

### 2. Get a knowledge base

You'll need a container runtime — [Apple Container](https://github.com/apple/container), [Docker](https://www.docker.com/), or [Podman](https://podman.io/), auto-detected.

Clone an existing knowledge base, or start your own — not this repo. Steps 3
and 4 run from inside it.

#### Clone a demo

[semiont-gutenberg-kb](https://github.com/The-AI-Alliance/semiont-gutenberg-kb), public-domain literature from Project Gutenberg:

```bash
git clone https://github.com/The-AI-Alliance/semiont-gutenberg-kb.git
cd semiont-gutenberg-kb
```

The full catalog — seven demo KBs across different domains, plus community
knowledge bases and the empty [template](https://github.com/The-AI-Alliance/semiont-template-kb) — is in **[docs/KNOWLEDGE-BASES.md](docs/KNOWLEDGE-BASES.md)**.

#### Start your own

Register your API key once, so `init` can use it to pick a current model:

```bash
semiont secret set ANTHROPIC_API_KEY op://YourVaultName/Anthropic/credential
```

Only the pointer is stored, never the value. It is verified once when you
register it, then read fresh on every start and passed to the containers as an
environment variable — Semiont writes it nowhere.

`semiont init` then births a KB in place: it stamps a permanent identity, and
synthesizes a config it validates before writing.

```bash
mkdir my-kb && cd my-kb
semiont init --yes --domain example.com:test --inference anthropic
```

The domain is the KB's permanent `did:web` identity, stamped into the committed
event log, so it has no safe default. `--inference anthropic` reaches
[Anthropic](https://www.anthropic.com/) for inference; `--inference ollama`
runs a small model locally through [Ollama](https://ollama.com/) instead, and
needs no key.

### 3. Start it

From inside the knowledge base:

```bash
semiont start
```

One command starts the whole stack and ensures the Semiont browser is running at **http://localhost:3000**. `semiont logs` follows it, `semiont stop` tears it down, and `semiont start --help` lists the options.

### 4. Connect

Create your first user. A fresh stack has none — the account is created at the knowledge base's identity provider, which is what Semiont trusts to authenticate people:

```bash
semiont useradd --email admin@example.com   # prompts for the password
```

Then open **http://localhost:3000**. The Semiont browser's Knowledge Bases panel discovers launcher-managed stacks automatically — pick yours and sign in with the email and password you just created. Sign-in happens at the identity provider, not at Semiont, so you'll be handed to its page and back, and it asks for your name on first use.

![Connect to knowledge base](website/assets/images/connect-kb.png)

For local-network access notes, supply-chain verification, and the native [desktop app](https://github.com/The-AI-Alliance/semiont/releases) alternative, see **[docs/browser/](docs/browser/README.md)**.

## Automate

Everything the Semiont browser does travels over one event bus, spoken as
**[eight verbs](docs/protocol/flows/README.md)**: browse, bind, yield, mark,
frame, gather, match, beckon. Two ways in — your shell, or your code.

### CLI

The launcher speaks those verbs itself, and it is the shortest way in:

```bash
semiont login          # approve in a browser; only tokens come back
semiont browse --help  # then any of the eight verbs
```

No password reaches the launcher, and the session renews itself; `semiont logout` ends it. It is the CLI's own session — an SDK app signs in separately.

Ingest a document with the same session — the file must live under the KB root,
since its storage URI is repo-relative:

```bash
semiont yield --upload papers/attention-is-all-you-need.pdf
```

### SDK

The **[Semiont SDK](packages/sdk/README.md)** (`@semiont/sdk`) is how your code speaks the same bus — a type-safe TypeScript client whose namespaces are those eight verbs. Your app never calls the gateway's HTTP API directly; the SDK is the boundary.

Here is a grounded answer — gather context by traversing the graph, then generate from it, with each claim cited back to its source:

```typescript
import { SemiontSession } from '@semiont/sdk';

const { client } = await SemiontSession.signInDevice({ kb, storage, onCode });

const context = await client.gather.resource(questionId, { excludeEntityTypes: ['Question'] });

const answer = await client.yield.fromResource(questionId, {
  title: question, storageUri: 'file://generated/answer.md', context,
  task: 'answer', structure: 'prose', cite: true,   // cite → linking annotations from claim to source
}).run((e) => { if (e.kind === 'progress') showProgress(e.data); });
```

New here? **[INTRODUCTION](packages/sdk/docs/INTRODUCTION.md)** is the orientation chapter — read it first, then the **[Developer Guide](packages/sdk/docs/DEVELOPER-GUIDE.md)** to build, with **[Usage](packages/sdk/docs/Usage.md)** open as the reference.

Built on the SDK: **[@semiont/react-ui](packages/react-ui/README.md)** embeds the resource viewer and annotation UI in your own app, and **[Agent Skills](docs/protocol/skills/)** are ready-made definitions for agentic coding assistants. A **[Go SDK](packages/sdk-go/README.md)** exists; more languages are planned — the contract is specified independently of any of them in **[docs/protocol/](docs/protocol/README.md)**.

## Contributing

> ⚠️ **Alpha.** API and package surface are not yet stable; breaking changes between 0.x releases are expected.

[![CI](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml?query=branch%3Amain)
[![License](https://img.shields.io/github/license/The-AI-Alliance/semiont)](https://github.com/The-AI-Alliance/semiont/tree/main?tab=Apache-2.0-1-ov-file#readme)
[![Issues](https://img.shields.io/github/issues/The-AI-Alliance/semiont)](https://github.com/The-AI-Alliance/semiont/issues)

- **[Development docs](docs/development/README.md)** — codebase layout, build status badges, Codespaces shortcut, where to read next.
- **[System architecture](docs/system/README.md)** — actor model, knowledge system, container topology, package architecture.
- **[Browser development](apps/browser/docs/DEVELOPMENT.md)** — running the Browser from source against a stack.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — branch/PR workflow, commit conventions, platform-contribution playbook.

## 📜 License

Apache 2.0 - See [LICENSE](LICENSE) for details.
