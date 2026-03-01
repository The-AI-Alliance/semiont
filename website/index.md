---
layout: default
title: Semiont - Your Sovereign AI Knowledge Platform
---

## Semiont

**Semiont is an open-source platform that builds a knowledge base directly from your documents — annotated, linked, and extended by humans and AI agents working together.**

Most organizations sit on vast document collections that are searchable but not *understood*. Semiont closes that gap. Import your corpus — contracts, research papers, product specs, regulatory filings — and the system immediately begins identifying entities, proposing annotations, and linking related concepts across documents. Domain experts review and refine what AI proposes; AI scales what experts start. The result is a grounded knowledge graph where every node traces back to a specific passage in a specific document.

That graph becomes infrastructure. Use it to power semantic search and contextual recommendations in your products. Feed it to RAG pipelines so your AI assistants answer from verified, cited sources instead of hallucinating. Automate compliance checks by querying relationships across regulatory documents. Surface hidden connections across research portfolios that would take analysts months to find manually. Every annotation your team creates — or your agents produce — compounds into an asset that makes the next query smarter, the next review faster, and the next product feature possible.

Built on the W3C Web Annotation standard — portable, interoperable, and sovereign on your infrastructure.

### Why Semiont?

**Eliminate Cold Starts** — Import a set of documents and the six flows immediately begin producing value: AI agents detect entity mentions, propose annotations, and generate linked resources while humans review, correct, and extend the results. The knowledge graph grows as a byproduct of annotation — no upfront schema design, manual data entry, or batch ETL pipeline required.

**Calibrate the Human–AI Mix** — Because humans and AI agents share identical interfaces, organizations can dial the mix to fit their constraints. A domain with abundant expert availability and a high accuracy bar can run human-primary workflows with AI suggestions; a domain rich in GPU capacity but short on specialists can run agent-primary pipelines with human spot-checks. Supervision depth, automation ratio, and quality gates are deployment decisions — not architectural rewrites.

### Core Tenets

**Peer Collaboration** — Humans and AI agents are architectural equals. Every operation flows through the same API, event bus, and event-sourced storage regardless of who initiates it. Any workflow can be performed manually, automated by an agent, or done collaboratively.

**Document-Grounded Knowledge** — Knowledge is always anchored to source documents. Annotations point into specific passages; references link documents to each other. The knowledge graph is a projection of these grounded relationships, not a replacement for the original material.

### Six Collaborative Flows

Humans and AI agents work as peers through six composable workflows:

- **[Yield](https://github.com/The-AI-Alliance/semiont/blob/main/docs/flows/YIELD.md)** — Introduce new resources into the system — upload documents, load pages, or generate new content from annotated references
- **[Mark](https://github.com/The-AI-Alliance/semiont/blob/main/docs/flows/MARK.md)** — Add structured metadata to resources — highlights, assessments, comments, tags, and entity references — manually or via AI-assisted detection
- **[Bind](https://github.com/The-AI-Alliance/semiont/blob/main/docs/flows/BIND.md)** — Resolve ambiguous references to specific resources, linking entity mentions to their correct targets in the knowledge base
- **[Gather](https://github.com/The-AI-Alliance/semiont/blob/main/docs/flows/GATHER.md)** — Assemble related context around a focal annotation for downstream generation or analysis
- **[Browse](https://github.com/The-AI-Alliance/semiont/blob/main/docs/flows/BROWSE.md)** — Navigate through resources, panels, and views — structured paths for reviewing and examining content
- **[Beckon](https://github.com/The-AI-Alliance/semiont/blob/main/docs/flows/BECKON.md)** — Direct user focus to specific annotations or regions of interest through visual cues and coordination signals

## Use Cases

- **Research & Analysis** - Annotate papers, extract citations, track provenance of ideas
- **Documentation** - Build interconnected knowledge bases with semantic linking
- **Legal & Compliance** - Review contracts, track references, manage regulatory content
- **Content Curation** - Organize multimedia resources with rich semantic metadata
- **Collaborative Knowledge** - Teams working together to build shared understanding

## Get Started Today

The [Semiont Agents Demo](https://github.com/The-AI-Alliance/semiont-agents) provides ready-to-run examples including document processing workflows, annotation detection, and interactive demos across various datasets.

[![Open Semiont Agents Demo](https://github.com/codespaces/badge.svg)](https://github.com/codespaces/new/The-AI-Alliance/semiont-agents)

## Open Source & Community

[![License](https://img.shields.io/github/license/The-AI-Alliance/semiont)](https://github.com/The-AI-Alliance/semiont/tree/main?tab=Apache-2.0-1-ov-file#readme)
[![GitHub stars](https://img.shields.io/github/stars/The-AI-Alliance/semiont?style=social)](https://github.com/The-AI-Alliance/semiont/stargazers)

Semiont is Apache 2.0 licensed and developed in the open. We welcome contributions from the community.

- **[View on GitHub](https://github.com/The-AI-Alliance/semiont)** - Explore the source code and documentation

---

**Part of the [AI Alliance](https://thealliance.ai/) — building open, safe, and beneficial AI for everyone.**
