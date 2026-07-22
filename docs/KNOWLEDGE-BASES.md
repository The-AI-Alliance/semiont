# Knowledge Bases

Semiont runs from a **knowledge-base repo** — a separate, small repository
holding your documents, configuration, and startup scripts — not from the
[semiont monorepo](https://github.com/The-AI-Alliance/semiont), which is the
platform source (it publishes the npm packages and the container images).

Every KB repo shares the same shape: configuration, the event log, compose
files, and inference presets under `.semiont/`. The stack is run by the
host-installed [`semiont` launcher](https://github.com/The-AI-Alliance/semiont/tree/main/apps/launcher)
(a single static binary), which *pulls* the published, attested
`ghcr.io/the-ai-alliance/semiont-*` images and bind-mounts the KB's config at
runtime — KB repos build no images of their own (see
[Container Images](system/administration/IMAGES.md)). One command starts the
whole stack, including the Semiont browser at http://localhost:3000:

```bash
brew install the-ai-alliance/semiont/semiont   # once
semiont start
semiont useradd --email admin@example.com --password <choose-a-password> --admin
```

`semiont logs` follows the stack, `semiont status` health-checks it, and
`semiont stop` tears it down — except the browser, which is the machine-level
viewer of every KB rather than a stack member: every start ensures it, stop
leaves it running, and `semiont stop --service frontend` is the explicit
off-switch. Its Knowledge Bases panel discovers launcher-managed stacks
automatically.

**Or run it on GitHub's machine instead of yours.** The same launcher places
a KB stack in a **GitHub Codespace** — one command creates (or resumes) the
codespace, waits for the stack to answer, forwards the KB to your machine,
and prints the admin credentials generated inside it:

```bash
semiont start --runtime codespace --repo The-AI-Alliance/semiont-template-kb
semiont start --service frontend    # the browser runs locally
```

Only the KB is forwarded, each stack on its own local port, so one local
browser works several cloud KBs at once via its Knowledge Bases panel.
`semiont status` shows the fleet; `semiont stop --repo <owner/name>` halts
billing (state persists) and `--delete` destroys the codespace. Prerequisites
(the `gh` CLI and an `ANTHROPIC_API_KEY` Codespaces user secret) are in each
KB's README; the raw `gh` recipe is kept there too as the no-launcher path.

See [Local Semiont](system/LOCAL-SEMIONT.md) for the full local-run guide
(inference configs, running from source with `SEMIONT_VERSION=local`, ports,
troubleshooting pointers).

## Starting from scratch

**`semiont init`** births a new KB in place — no clone required. It stamps
the permanent did:web identity at birth (from `--domain` or your git
origin), synthesizes a validated semiontconfig from `--inference` /
`--model` / `--embedding` choices (or copies the template's configs with
`--from-template`), and refuses rather than writing a config that cannot
start:

```bash
semiont init --yes --inference anthropic --embedding ollama:nomic-embed-text
```

Or clone the empty template:

| Template | Description | Clone |
|---|---|---|
| **[semiont-template-kb](https://github.com/The-AI-Alliance/semiont-template-kb)** | Empty template — start here for a new project | `git clone https://github.com/The-AI-Alliance/semiont-template-kb.git` |

The template is the canonical source of the shared `.semiont/` scaffolding —
the demo KBs below are forks of it, kept in sync.

## Demo KBs

Each ships a small corpus and a layered set of skills (ingest → mark →
canonicalize → wire-edges → compose-aggregates) that demonstrate the SDK in a
particular domain. The value is the *skills*, not the data — the skills are
corpus-generic and work on any corpus dropped into the same directory layout.

| Knowledge Base | Domain | Clone |
|---|---|---|
| **[semiont-gutenberg-kb](https://github.com/The-AI-Alliance/semiont-gutenberg-kb)** | Public-domain literature from Project Gutenberg | `git clone https://github.com/The-AI-Alliance/semiont-gutenberg-kb.git` |
| **[semiont-arxiv-kb](https://github.com/The-AI-Alliance/semiont-arxiv-kb)** | Research papers from arXiv | `git clone https://github.com/The-AI-Alliance/semiont-arxiv-kb.git` |
| **[semiont-legal-kb](https://github.com/The-AI-Alliance/semiont-legal-kb)** | Synthetic legal documents — contracts, attorney correspondence, internal memos | `git clone https://github.com/The-AI-Alliance/semiont-legal-kb.git` |
| **[semiont-caselaw-kb](https://github.com/The-AI-Alliance/semiont-caselaw-kb)** | U.S. case law — Supreme Court opinions and state appellate cases | `git clone https://github.com/The-AI-Alliance/semiont-caselaw-kb.git` |
| **[semiont-clinical-evidence-kb](https://github.com/The-AI-Alliance/semiont-clinical-evidence-kb)** | Synthetic clinical evidence — trials, observational studies, treatment guidelines, drug-safety reports | `git clone https://github.com/The-AI-Alliance/semiont-clinical-evidence-kb.git` |
| **[semiont-newsroom-kb](https://github.com/The-AI-Alliance/semiont-newsroom-kb)** | Synthetic investigative-journalism documents — interview transcripts, FOIA responses, public statements | `git clone https://github.com/The-AI-Alliance/semiont-newsroom-kb.git` |
| **[semiont-household-kb](https://github.com/The-AI-Alliance/semiont-household-kb)** | Synthetic home-property records — service receipts, contractor emails, manuals, mortgage / insurance, HOA notices | `git clone https://github.com/The-AI-Alliance/semiont-household-kb.git` |

## Community

| Knowledge Base | Domain | Clone |
|---|---|---|
| **[synthetic-family](https://github.com/pingel-org/synthetic-family)** | Synthetic family history and genealogy | `git clone https://github.com/pingel-org/synthetic-family.git` |

Built a knowledge base others could learn from? Open a
[discussion](https://github.com/The-AI-Alliance/semiont/discussions) to get
it listed here.
