# Monorepo Orientation

Where the code lives, how it builds, and how to start working on Semiont itself. Read this if you want to fix a bug, ship a feature, or understand the layered package design. For workflow conventions and the PR process, see **[CONTRIBUTING.md](../../CONTRIBUTING.md)**.

> ⚠️ **Early development.** Semiont is in active alpha. The API and package surface are not yet stable; breaking changes between 0.x releases are expected. External consumers should pin minor versions and read [release notes](https://github.com/The-AI-Alliance/semiont/releases) before upgrading.

## Build & quality status

[![Continuous Integration](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml?query=branch%3Amain)
[![Security Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/security-tests.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont/actions/workflows/security-tests.yml?query=branch%3Amain)
[![Accessibility Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/accessibility-tests.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont/actions/workflows/accessibility-tests.yml?query=branch%3Amain)
[![WCAG 2.1 AA](https://img.shields.io/badge/WCAG-2.1%20AA-blue.svg)](../../apps/frontend/docs/ACCESSIBILITY.md)
[![License](https://img.shields.io/github/license/The-AI-Alliance/semiont)](https://github.com/The-AI-Alliance/semiont/tree/main?tab=Apache-2.0-1-ov-file#readme)
[![Issues](https://img.shields.io/github/issues/The-AI-Alliance/semiont)](https://github.com/The-AI-Alliance/semiont/issues)

## Get a workstation

**GitHub Codespaces** (one-click, fastest):

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://github.com/codespaces/new/The-AI-Alliance/semiont)

See [.devcontainer/README.md](../../.devcontainer/README.md) for what the prebuilt environment ships with.

**Local checkout** — clone the repo and follow [LOCAL-DEVELOPMENT.md](LOCAL-DEVELOPMENT.md) Path B (Building from Source). Path A in the same doc is for running an external KB project against published packages; Path B is the contributor workflow.

## Repository layout

```text
semiont/
├── specs/                      # API specifications (spec-first architecture)
│   ├── src/                    # OpenAPI source files (tracked in git)
│   │   ├── openapi.json        # Root spec with $ref to all paths/schemas
│   │   ├── paths/              # Individual endpoint definitions
│   │   └── components/
│   │       └── schemas/        # Schema definitions
│   ├── openapi.json            # Generated bundle (gitignored, built by Redocly)
│   └── docs/                   # API and W3C annotation documentation
├── apps/                       # Application packages
│   ├── frontend/               # Vite + React frontend SPA
│   ├── backend/                # Hono backend API server
│   └── cli/                    # Semiont management CLI
├── packages/                   # Shared workspace packages (see packages/README.md)
│   ├── core/                   # OpenAPI types, branded IDs, event protocol
│   ├── api-client/             # HTTP transport adapter (HttpTransport, HttpContentTransport)
│   ├── sdk/                    # SemiontClient, namespaces, session, view-models
│   ├── ontology/               # Entity types and tag schemas
│   ├── content/                # Content-addressed storage
│   ├── event-sourcing/         # Event store and materialized views
│   ├── graph/                  # Graph database abstraction
│   ├── vectors/                # Vector storage, embeddings, semantic search
│   ├── inference/              # AI prompts, parsers, and text generation
│   ├── jobs/                   # Job queue and worker infrastructure
│   ├── make-meaning/           # Context assembly, detection, reasoning
│   ├── react-ui/               # React components and hooks
│   ├── mcp-server/             # Model Context Protocol server
│   ├── observability/          # OpenTelemetry helpers (withSpan, traceparent, init)
│   └── test-utils/             # Testing utilities and mock factories
├── docs/                       # System documentation
│   ├── development/            # Contributor-facing (this file, LOCAL-DEVELOPMENT, RELEASE, TESTING)
│   ├── administration/         # Operator-facing (deployment, security, observability, etc.)
│   ├── flows/                  # The seven collaborative flows (yield, mark, match, …)
│   └── skills/                 # Agent skill definitions for Claude Code and similar tools
└── scripts/                    # Build and utility scripts
```

The layered architecture, dependency graph, and per-package summaries live in **[packages/README.md](../../packages/README.md)**.

## Where to read next

- **[CONTRIBUTING.md](../../CONTRIBUTING.md)** — branch/PR workflow, commit conventions, platform-contribution playbook.
- **[ARCHITECTURE.md](../ARCHITECTURE.md)** — system design, event sourcing, layered package boundaries.
- **[LOCAL-DEVELOPMENT.md](LOCAL-DEVELOPMENT.md)** — running locally; Path B for contributors building from source.
- **[TESTING.md](TESTING.md)** — testing conventions and infrastructure.
- **[RELEASE.md](RELEASE.md)** — versioning and release process.
- **[packages/README.md](../../packages/README.md)** — full package inventory with dependency graph.
