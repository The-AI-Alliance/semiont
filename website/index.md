---
layout: default
title: Semiont - Semantic Wiki for Humans and AI
---

## Semiont

**Semiont is an open-source semantic wiki where humans and AI agents collaboratively annotate, link, and extend a shared corpus of documents.**

![Semiont screenshot](assets/images/semiont-2026-03-10.png)

Most organizations sit on vast document collections that are searchable but not *understood*. Semiont closes that gap. Import your corpus — contracts, research papers, product specs, regulatory filings — and the system immediately begins identifying entities, proposing annotations, and linking related concepts across documents. Domain experts review and refine what AI proposes; AI scales what experts start. The result is a grounded knowledge graph where every node traces back to a specific passage in a specific document — a semantic wiki that grows smarter with every interaction.

That wiki becomes infrastructure. Use it to power semantic search and contextual recommendations in your products. Feed it to RAG pipelines so your AI assistants answer from verified, cited sources instead of hallucinating. Automate compliance checks by querying relationships across regulatory documents. Surface hidden connections across research portfolios that would take analysts months to find manually. Every annotation your team creates — or your agents produce — compounds into an asset that makes the next query smarter, the next review faster, and the next product feature possible.

Self-hosted, so your data stays on your infrastructure. Inference runs on **[Anthropic](https://www.anthropic.com/)** (cloud) or **[Ollama](https://ollama.com/)** (fully local) — mix providers per worker to balance cost, capability, and privacy. Built on the W3C Web Annotation standard — portable, interoperable, and sovereign.

### Why Semiont?

**Eliminate Cold Starts** — Import a set of documents and the seven flows immediately begin producing value: AI agents detect entity mentions, propose annotations, and generate linked resources while humans review, correct, and extend the results. The knowledge graph grows as a byproduct of annotation — no upfront schema design, manual data entry, or batch ETL pipeline required.

**Calibrate the Human–AI Mix** — Because humans and AI agents share identical interfaces, organizations can dial the mix to fit their constraints. A domain with abundant expert availability and a high accuracy bar can run human-primary workflows with AI suggestions; a domain rich in GPU capacity but short on specialists can run agent-primary pipelines with human spot-checks. Supervision depth, automation ratio, and quality gates are deployment decisions — not architectural rewrites.

### Core Tenets

**Peer Collaboration** — Humans and AI agents are architectural equals. Every operation flows through the same API, event bus, and event-sourced storage regardless of who initiates it. Any workflow can be performed manually, automated by an agent, or done collaboratively — through the GUI, the [CLI](https://github.com/The-AI-Alliance/semiont/tree/main/apps/cli), the [TypeScript SDK](https://github.com/The-AI-Alliance/semiont/tree/main/packages/api-client), or [agent skills](https://github.com/The-AI-Alliance/semiont/tree/main/docs/skills) for agentic coding assistants.

**Document-Grounded Knowledge** — Knowledge is always anchored to source documents. Annotations point into specific passages; references link documents to each other. The knowledge graph is a projection of these grounded relationships, not a replacement for the original material.

### Seven Collaborative Flows

Humans and AI agents work as peers through seven composable workflows:

- **[Yield](https://github.com/The-AI-Alliance/semiont/blob/main/docs/flows/YIELD.md)** — Introduce new resources into the system — upload documents, load pages, or generate new content from annotated references
- **[Mark](https://github.com/The-AI-Alliance/semiont/blob/main/docs/flows/MARK.md)** — Add structured metadata to resources — highlights, assessments, comments, tags, and entity references — manually or via AI-assisted detection
- **[Match](https://github.com/The-AI-Alliance/semiont/blob/main/docs/flows/MATCHER.md)** — Search the knowledge base for candidate resources using multi-source retrieval and composite scoring — structural signals plus optional LLM re-ranking
- **[Bind](https://github.com/The-AI-Alliance/semiont/blob/main/docs/flows/BIND.md)** — Resolve ambiguous references to specific resources, linking entity mentions to their correct targets in the knowledge base
- **[Gather](https://github.com/The-AI-Alliance/semiont/blob/main/docs/flows/GATHER.md)** — Assemble related context around a focal annotation for downstream generation or analysis
- **[Browse](https://github.com/The-AI-Alliance/semiont/blob/main/docs/flows/BROWSE.md)** — Navigate through resources, panels, and views — structured paths for reviewing and examining content
- **[Beckon](https://github.com/The-AI-Alliance/semiont/blob/main/docs/flows/BECKON.md)** — Direct user focus to specific annotations or regions of interest through visual cues and coordination signals

## Use Cases

- **Research & Analysis** — Annotate papers, trace citations, track provenance of ideas across a growing corpus
- **Legal & Compliance** — Review contracts, query relationships across regulatory filings, automate cross-reference checks
- **Organizational Knowledge** — Build a living wiki from internal documents where teams and AI agents co-curate institutional knowledge
- **RAG & Retrieval** — Ground LLM responses in cited, annotated sources instead of unchecked generation
- **Content Curation** — Organize resources with rich semantic metadata, entity linking, and AI-assisted tagging
- **Agentic Memory** — Give AI agents a persistent, structured knowledge base they can read from and write to

## Get Started

Clone the empty template and start the backend — no npm or Node.js required:

```bash
git clone https://github.com/The-AI-Alliance/semiont-empty-kb.git my-kb
cd my-kb
export ANTHROPIC_API_KEY=<your-api-key>
.semiont/scripts/local_backend.sh --email admin@example.com --password password
```

Or explore a pre-populated knowledge base:

- **[gutenberg-kb](https://github.com/The-AI-Alliance/gutenberg-kb)** — Public domain literature from Project Gutenberg
- **[synthetic-family](https://github.com/pingel-org/synthetic-family)** — Synthetic family dataset for testing and exploration

See the **[Quick Start](https://github.com/The-AI-Alliance/semiont#quick-start)** for full setup instructions.

## Open Source & Community

[![License](https://img.shields.io/github/license/The-AI-Alliance/semiont)](https://github.com/The-AI-Alliance/semiont/tree/main?tab=Apache-2.0-1-ov-file#readme)
[![GitHub stars](https://img.shields.io/github/stars/The-AI-Alliance/semiont?style=social)](https://github.com/The-AI-Alliance/semiont/stargazers)

Semiont is Apache 2.0 licensed and developed in the open. We welcome contributions from the community.

- **[View on GitHub](https://github.com/The-AI-Alliance/semiont)** — Explore the source code and documentation

---

**Part of the [AI Alliance](https://thealliance.ai/) — building open, safe, and beneficial AI for everyone.**
