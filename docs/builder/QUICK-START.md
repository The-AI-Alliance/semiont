# Quick Start

From nothing to a knowledge base running on your machine, with a document in it and your first annotations.

## 0. Prerequisites

You'll need a container runtime — [Apple Container](https://github.com/apple/container), [Docker](https://www.docker.com/), or [Podman](https://podman.io/), auto-detected.

## 1. Install

The `semiont` launcher is a single static binary — no npm, no Node.js:

```bash
brew install the-ai-alliance/semiont/semiont
```

Homebrew serves macOS and Linux. On Windows, the [GitHub Release](https://github.com/The-AI-Alliance/semiont/releases) carries a zip holding `semiont.exe` — see [Semiont on Windows](../operator/platforms/WINDOWS.md).

## 2. Configure Settings

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

## 3. Create a knowledge base

`semiont init` creates a KB in place, synthesizing a config it validates before writing:

```bash
mkdir my-kb && cd my-kb
semiont init --yes --domain example.com:my-kb --inference anthropic
```

**Change `--domain`** — it is the KB's permanent identity, stamped into the committed event log, and has no default. Use `--inference ollama` instead if you chose the local model above.

Every step below runs from inside the knowledge base — not from this repo.

To start from a knowledge base that already has content instead, clone one of the [demo knowledge bases](../KNOWLEDGE-BASES.md) and go on to step 4.

## 4. Start it

One command starts the whole stack and ensures the Semiont browser is running at **http://localhost:3000**:

```bash
semiont start
```

`semiont status` reports each service's state and health, `semiont logs` follows it, `semiont stop` tears it down, and `semiont start --help` lists the options.

## 5. Create a user

A fresh stack has no users. The account is created at the knowledge base's identity provider, which is what Semiont trusts to authenticate people:

```bash
semiont useradd --email admin@example.com   # prompts for the password
```

## 6. Sign in

Open **http://localhost:3000**. The Semiont browser's Knowledge Bases panel discovers launcher-managed stacks automatically — pick yours and sign in with the email and password you just created. Sign-in happens at the identity provider, not at Semiont, so you'll be handed to its page and back, and it asks for your name on first use.

![Connect to knowledge base](../../website/assets/images/connect-kb.png)

Sign the launcher in as well — it holds a session of its own, which the next step needs:

```bash
semiont login          # approve in a browser; only tokens come back
```

No password reaches the launcher, and the session renews itself; `semiont logout` ends it. It is the CLI's own session — an SDK app signs in separately.

For local-network access notes, supply-chain verification, and the native [desktop app](https://github.com/The-AI-Alliance/semiont/releases) alternative, see the **[analyst docs](../analyst/README.md)**.

## 7. Ingest content

Pull down a well-known paper and upload it with the session from step 6. The storage URI is repo-relative, so the file has to land under the KB root first:

```bash
mkdir -p papers
curl -L -o papers/attention-is-all-you-need.pdf https://arxiv.org/pdf/1706.03762
semiont yield --upload papers/attention-is-all-you-need.pdf
```

## 8. Annotate

![The Semiont browser: a document with its references highlighted, and a panel of assessments beside it](../../website/assets/images/semiont-2026-03-10.png)

Open the document you just ingested and start marking it up — highlight a passage, tag an entity, link a claim to the source that supports it. You are not doing it alone: AI agents reach the same document over the same bus, proposing references and entity types for you to accept, refine, or throw out. Every annotation records who made it, human or agent, and the two are the same kind of participant here.

The CLI asks for the same work. This has the stack detect references to concepts, given the resource id that step 7 printed:

```bash
semiont mark --delegate <resourceId> --motivation linking --entity-type Concept
```

## Next

Everything you just did travelled over one event bus, spoken as [eight verbs](../protocol/flows/README.md): `semiont yield` and `semiont mark` were two of them. The launcher speaks all eight (`semiont browse --help`, and so on), and so does your code, through the SDK.

- **[Building with the Semiont SDK](README.md)**: the same verbs from TypeScript or Rust
- **[Working in the Browser](../analyst/FEATURES.md)**: what you can do with the document you just opened
- **[Running a local stack](../operator/LOCAL-SEMIONT.md)**: what this page leaves out about the stack you just started
