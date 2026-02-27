# Semiont - Semantic Knowledge Kernel

[![Development Status](https://img.shields.io/badge/status-alpha-orange.svg)](https://github.com/The-AI-Alliance/semiont)
[![API Stability](https://img.shields.io/badge/API-unstable-red.svg)](https://github.com/The-AI-Alliance/semiont)
[![Continuous Integration](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml?query=branch%3Amain)
[![Security Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/security-tests.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont/actions/workflows/security-tests.yml?query=branch%3Amain)
[![Accessibility Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/accessibility-tests.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont/actions/workflows/accessibility-tests.yml?query=branch%3Amain)
[![WCAG 2.1 AA](https://img.shields.io/badge/WCAG-2.1%20AA-blue.svg)](apps/frontend/docs/ACCESSIBILITY.md)
[![License](https://img.shields.io/github/license/The-AI-Alliance/semiont)](https://github.com/The-AI-Alliance/semiont/tree/main?tab=Apache-2.0-1-ov-file#readme)
[![Issues](https://img.shields.io/github/issues/The-AI-Alliance/semiont)](https://github.com/The-AI-Alliance/semiont/issues)
[![Contributions Welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Code of Conduct](https://img.shields.io/badge/code%20of%20conduct-active-blue.svg)](CODE_OF_CONDUCT.md)

> ⚠️ **Early Development**: Semiont is in active alpha development. The API is not yet stable and breaking changes are expected. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to participate.

**The open-source, future-proof framework that enables humans and intelligent agents to co-create shared knowledge — governed by you and built to last.**

Semiont is a standards-compliant multimedia resource management system built on the **W3C Web Annotation** model. It transforms unstructured content into interconnected semantic networks through collaborative markup, linking, and AI-powered knowledge extraction—all stored as standard, interoperable annotations.

**Five Collaborative Flows** — humans and AI agents work as peers through five composable workflows (Attend → Annotate → Resolve → Correlate → Generate):

- **[Attend](docs/flows/ATTEND.md)** — Focus on a resource or annotation; hover, click, and navigation signals coordinate all panels and views
- **[Annotate](docs/flows/ANNOTATE.md)** — Create highlights, assessments, comments, tags, and entity references — manually or via AI-assisted detection
- **[Resolve](docs/flows/RESOLVE.md)** — Link reference annotations to existing resources or create new ones
- **[Correlate](docs/flows/CORRELATE.md)** — Extract semantic context from annotations and the knowledge graph for downstream use
- **[Generate](docs/flows/GENERATE.md)** — Synthesize new resources from reference annotations using correlated context

Use it as a Wiki, an Annotator, or a Research tool. Run it on your infrastructure with your data for true **sovereign AI**.

## 📁 File Layout

```text
semiont/
├── specs/                      # API specifications (spec-first architecture)
│   ├── src/                    # OpenAPI source files (tracked in git)
│   │   ├── openapi.json        # Root spec with $ref to all paths/schemas
│   │   ├── paths/              # Individual endpoint definitions (37 files)
│   │   └── components/
│   │       └── schemas/        # Schema definitions (79 files)
│   ├── openapi.json            # Generated bundle (gitignored, built by Redocly)
│   └── docs/                   # API and W3C annotation documentation
├── apps/                       # Application packages
│   ├── frontend/               # Next.js 14 frontend application
│   ├── backend/                # Hono backend API server
│   └── cli/                    # Semiont management CLI
├── packages/                   # Shared workspace packages (see packages/README.md)
│   ├── api-client/             # OpenAPI-generated TypeScript SDK
│   ├── core/                   # Core types and utilities
│   ├── event-sourcing/         # Event store and view storage
│   ├── content/                # Content-addressed storage
│   ├── graph/                  # Graph database abstraction
│   ├── ontology/               # Entity types and tag schemas
│   ├── inference/              # AI prompts, parsers, and text generation
│   ├── make-meaning/           # Context assembly, detection, reasoning
│   ├── jobs/                   # Job queue and worker infrastructure
│   ├── react-ui/               # React components and hooks
│   ├── mcp-server/             # Model Context Protocol server
│   └── test-utils/             # Testing utilities and mock factories
├── docs/                       # System documentation
└── scripts/                    # Build and utility scripts
```

**See [packages/README.md](packages/README.md) for detailed package documentation, architecture overview, and dependency graph.**

## 🚀 Getting Started

### For Development & Contributing

**GitHub Codespaces** (Recommended for quick setup):

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://github.com/codespaces/new/The-AI-Alliance/semiont)

See [.devcontainer/README.md](.devcontainer/README.md) for setup details.

**Local Development**:

See [LOCAL-DEVELOPMENT.md](docs/LOCAL-DEVELOPMENT.md) for installation, configuration, and running locally.

### For Demos & Examples

**Semiont Agents Demo** - Interactive examples showing Semiont SDK usage:

[![Open Semiont Agents Demo](https://github.com/codespaces/badge.svg)](https://github.com/codespaces/new/The-AI-Alliance/semiont-agents)

The [Semiont Agents Demo](https://github.com/The-AI-Alliance/semiont-agents) repository provides ready-to-run examples including:
- Document processing workflows (chunking, table of contents)
- Annotation detection (legal citations, highlights, tags)
- Interactive terminal UI for running demos
- Various datasets (Supreme Court cases, research papers, genealogical records)

[→ Visit Semiont Agents Demo Repository](https://github.com/The-AI-Alliance/semiont-agents)

## 📦 Published Artifacts

Semiont publishes npm packages and container images for easy integration and deployment.

- **NPM Packages** - See [packages/README.md](packages/README.md) for available packages and documentation
- **Container Images** - See [docs/IMAGES.md](docs/IMAGES.md) for Docker images and deployment examples

## 📖 Documentation

| Document | Description |
| --- | --- |
| **[Architecture](docs/ARCHITECTURE.md)** | System design, event sourcing, and layered package structure |
| **[W3C Web Annotation](specs/docs/W3C-WEB-ANNOTATION.md)** | How Semiont implements the W3C standard across all layers |
| **[Local Development](docs/LOCAL-DEVELOPMENT.md)** | Get running locally — prerequisites, configuration, first launch |
| **[API Reference](specs/docs/API.md)** | HTTP endpoints ([OpenAPI spec](specs/README.md)) |
| **[Packages](packages/README.md)** | All published npm packages with dependency graph |
| **[Deployment](docs/DEPLOYMENT.md)** | Production deployment, platforms, scaling, and maintenance |
| **[Security](docs/SECURITY.md)** | Authentication, RBAC, and security controls |
| **[Contributing](CONTRIBUTING.md)** | How to participate, testing guide, and development standards |

### Applications

| Application | Description |
| --- | --- |
| **[Backend](apps/backend/README.md)** | Hono API server — routes, event bridging, real-time SSE, logging |
| **[Frontend](apps/frontend/README.md)** | Next.js app — annotations, accessibility, i18n, performance |
| **[CLI](apps/cli/README.md)** | Environment management, service orchestration, deployment commands |

## 📜 License

Apache 2.0 - See [LICENSE](LICENSE) for details.
