# Semiont

**Semiont is an open, source-grounded semantic knowledge platform for building and maintaining trusted AI knowledge bases and context layers. It gives humans and AI agents a shared workspace and architecture to annotate, connect, enrich, and govern domain knowledge for accurate applications, agents, and workflows.**

## Quick Start

### 0. Prerequisites

You'll need a container runtime — [Apple Container](https://github.com/apple/container), [Docker](https://www.docker.com/), or [Podman](https://podman.io/), auto-detected.

### 1. Install

The `semiont` launcher is a single static binary — no npm, no Node.js:

```bash
brew install the-ai-alliance/semiont/semiont
```

Homebrew serves macOS and Linux. On Windows, the [GitHub Release](https://github.com/The-AI-Alliance/semiont/releases) carries a zip holding `semiont.exe` — see [Semiont on Windows](docs/system/platforms/WINDOWS.md).

### 2. Configure Settings

Name your vault. By default the secrets the launcher generates for a knowledge base are plain files, which are not secure and are for development only. To keep every new knowledge base's in 1Password, set that before creating one:

```bash
semiont settings secret-store --default op://YourVaultName
```

Then register your [Anthropic](https://www.anthropic.com/) key once, as a pointer into that vault — only the pointer is stored, read fresh on every start and passed to the containers, written nowhere:

```bash
semiont settings secret set ANTHROPIC_API_KEY op://YourVaultName/Anthropic/credential
```

A local model needs no secret: [Ollama](https://ollama.com/) runs a small one on your own machine, selected in the next step, and no content leaves your machine.

`semiont settings` lists every setting the launcher keeps, with its value and where it came from.

### 3. Create a knowledge base

`semiont init` creates a KB in place, synthesizing a config it validates before writing:

```bash
mkdir my-kb && cd my-kb
semiont init --yes --domain example.com:my-kb --inference anthropic
```

**Change `--domain`** — it is the KB's permanent identity, stamped into the committed event log, and has no default. Use `--inference ollama` instead if you chose the local model above.

Every step below runs from inside the knowledge base — not from this repo.

### 4. Start it

One command starts the whole stack and ensures the Semiont browser is running at **http://localhost:3000**:

```bash
semiont start
```

`semiont logs` follows it, `semiont stop` tears it down, and `semiont start --help` lists the options.

### 5. Create a user

A fresh stack has no users. The account is created at the knowledge base's identity provider, which is what Semiont trusts to authenticate people:

```bash
semiont useradd --email admin@example.com   # prompts for the password
```

### 6. Sign in

Open **http://localhost:3000**. The Semiont browser's Knowledge Bases panel discovers launcher-managed stacks automatically — pick yours and sign in with the email and password you just created. Sign-in happens at the identity provider, not at Semiont, so you'll be handed to its page and back, and it asks for your name on first use.

![Connect to knowledge base](website/assets/images/connect-kb.png)

Sign the launcher in as well — it holds a session of its own, which the next step needs:

```bash
semiont login          # approve in a browser; only tokens come back
```

No password reaches the launcher, and the session renews itself; `semiont logout` ends it. It is the CLI's own session — an SDK app signs in separately.

For local-network access notes, supply-chain verification, and the native [desktop app](https://github.com/The-AI-Alliance/semiont/releases) alternative, see **[docs/browser/](docs/browser/README.md)**.

### 7. Ingest content

Pull down a well-known paper and upload it with the session from step 6. The storage URI is repo-relative, so the file has to land under the KB root first:

```bash
mkdir -p papers
curl -L -o papers/attention-is-all-you-need.pdf https://arxiv.org/pdf/1706.03762
semiont yield --upload papers/attention-is-all-you-need.pdf
```

### 8. Annotate

![Semiont screenshot](website/assets/images/semiont-2026-03-10.png)

Open the document you just ingested and start marking it up — highlight a passage, tag an entity, link a claim to the source that supports it. You are not doing it alone: AI agents reach the same document over the same bus, proposing references and entity types for you to accept, refine, or throw out. Every annotation records who made it, human or agent, and the two are the same kind of participant here.

The CLI asks for the same work. This has the stack detect references to concepts, given the resource id that step 7 printed:

```bash
semiont mark --delegate <resourceId> --motivation linking --entity-type Concept
```

## Automate

Everything the Semiont browser does travels over one event bus, spoken as
**[eight verbs](docs/protocol/flows/README.md)**: browse, bind, yield, mark,
frame, gather, match, beckon. You have been speaking them already — `semiont yield`
was one. The launcher speaks all eight (`semiont browse --help`, and so on), and so does
your code.

The Semiont SDK is how your code speaks the same bus — a type-safe client whose namespaces are those eight verbs. It comes in **[TypeScript](packages/sdk/README.md)** (`@semiont/sdk`) and **[Rust](packages/sdk-rust/README.md)** ([`semiont`](https://crates.io/crates/semiont)), full peers held to the same [conformance suite](tests/conformance/sdk/README.md). Your app never calls the gateway's HTTP API directly; the SDK is the boundary.

```bash
npm install @semiont/sdk                    # TypeScript
cargo add semiont semiont-http-transport    # Rust
```

Built on the SDK: **[@semiont/react-ui](packages/react-ui/README.md)** embeds the resource viewer and annotation UI in your own app, and **[Agent Skills](docs/protocol/skills/)** are ready-made definitions for agentic coding assistants. The contract both SDKs speak is specified independently of either in **[docs/protocol/](docs/protocol/README.md)**.

## Demo and Community KBs

Rather than starting empty, clone a knowledge base that already carries content. [semiont-gutenberg-kb](https://github.com/The-AI-Alliance/semiont-gutenberg-kb) holds public-domain literature from Project Gutenberg:

```bash
git clone https://github.com/The-AI-Alliance/semiont-gutenberg-kb.git
cd semiont-gutenberg-kb
```

It arrives with its identity and configs already set, so skip step 3. A plain `semiont start` runs its local Ollama config; `semiont start --config anthropic` runs on the key from step 2 instead. It ships with content, so step 7 is optional.

The full catalog — seven demo KBs across different domains, plus community
knowledge bases and the empty [template](https://github.com/The-AI-Alliance/semiont-template-kb) — is in **[docs/KNOWLEDGE-BASES.md](docs/KNOWLEDGE-BASES.md)**.

## Contributing

> ⚠️ **Alpha.** API and package surface are not yet stable; breaking changes between 0.x releases are expected.

[![CI](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml?query=branch%3Amain)
[![License](https://img.shields.io/github/license/The-AI-Alliance/semiont)](https://github.com/The-AI-Alliance/semiont/tree/main?tab=Apache-2.0-1-ov-file#readme)
[![Issues](https://img.shields.io/github/issues/The-AI-Alliance/semiont)](https://github.com/The-AI-Alliance/semiont/issues)

New here? The SDK's **[INTRODUCTION](packages/sdk/docs/INTRODUCTION.md)** is the orientation chapter — read it first, then the **[Developer Guide](packages/sdk/docs/DEVELOPER-GUIDE.md)** to build, with **[Usage](packages/sdk/docs/Usage.md)** open as the reference.

- **[Development docs](docs/development/README.md)** — codebase layout, build status badges, Codespaces shortcut, where to read next.
- **[System architecture](docs/system/README.md)** — actor model, knowledge system, container topology, package architecture.
- **[Browser development](apps/browser/docs/DEVELOPMENT.md)** — running the Browser from source against a stack.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — branch/PR workflow, commit conventions, platform-contribution playbook.

## 📜 License

Apache 2.0 - See [LICENSE](LICENSE) for details.
