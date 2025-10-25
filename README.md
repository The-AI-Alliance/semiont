# Semiont - Semantic Knowledge Platform

[![Development Status](https://img.shields.io/badge/status-alpha-orange.svg)](https://github.com/The-AI-Alliance/semiont)
[![API Stability](https://img.shields.io/badge/API-unstable-red.svg)](https://github.com/The-AI-Alliance/semiont)
[![Continuous Integration](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml?query=branch%3Amain)
[![Security Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/security-tests.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont/actions/workflows/security-tests.yml?query=branch%3Amain)
[![License](https://img.shields.io/github/license/The-AI-Alliance/semiont)](https://github.com/The-AI-Alliance/semiont/tree/main?tab=Apache-2.0-1-ov-file#readme)
[![Issues](https://img.shields.io/github/issues/The-AI-Alliance/semiont)](https://github.com/The-AI-Alliance/semiont/issues)
[![Contributions Welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Code of Conduct](https://img.shields.io/badge/code%20of%20conduct-active-blue.svg)](CODE_OF_CONDUCT.md)

> ⚠️ **Early Development**: Semiont is in active alpha development. The API is not yet stable and breaking changes are expected. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to participate.

**The open-source, future-proof framework that enables humans and intelligent agents to co-create shared knowledge — governed by you and built to last.**

An AI-native knowledge base for human/agent collaboration. Use it as a Wiki, an Annotator, or a Research tool. Run it on your infrastructure with your data for true **sovereign AI**.

Built on the **W3C Web Annotation** standard, Semiont automatically extracts knowledge graphs from unstructured content, enabling collaborative annotation, linking, and reasoning over documents. It transforms text into interconnected semantic networks with entity recognition, relationship extraction, and contextual understanding—all stored as standard, interoperable annotations.

## 📁 File Layout

```text
semiont/
├── specs/                # API specifications (spec-first architecture)
│   ├── openapi.json      # OpenAPI 3.0 REST API specification (source of truth)
│   └── docs/             # API and W3C annotation documentation
├── apps/                 # Application packages
│   ├── frontend/         # Next.js 14 frontend application
│   ├── backend/          # Hono backend API server
│   └── cli/              # Semiont management CLI
├── packages/             # Shared workspace packages
│   ├── core/             # Core TypeScript SDK with types, schemas, and utilities
│   ├── api-client/       # TypeScript SDK generated from OpenAPI spec
│   ├── mcp-server/       # Model Context Protocol server for AI integration
│   └── test-utils/       # Testing utilities and mock factories
├── demo/                 # Example scripts and demonstrations
├── docs/                 # System documentation
└── scripts/              # Build and utility scripts
```

## 📦 API Client & Demo

### Semiont API Client

The **[@semiont/api-client](packages/api-client/)** provides a generated OpenAPI client for external applications:

```typescript
import { SemiontApiClient } from '@semiont/api-client';

const client = new SemiontApiClient({
  baseUrl: 'http://localhost:4000'
});

await client.authenticateLocal('user@example.com', '123456');
const doc = await client.createDocument({
  name: 'My Document',
  content: 'Hello World',
  format: 'text/plain',
  entityTypes: ['example']
});
```

**Features:**

- 🎯 Complete TypeScript types generated from [OpenAPI specification](specs/openapi.json)
- 🔌 High-level API client with authentication and error handling
- ✅ Type-safe request/response handling
- 🔄 Spec-first development: Types generated from canonical [specs/openapi.json](specs/openapi.json)

For internal use, **[@semiont/core](packages/core/)** provides shared types, schemas, and utilities used across the monorepo.

**Documentation:**
- [API Client README](packages/api-client/README.md) - SDK usage and utilities
- [API Reference](specs/docs/API.md) - Complete HTTP API endpoint documentation
- [OpenAPI Specification](specs/openapi.json) - Machine-readable API contract

### Demo Scripts

The **[demo/](demo/)** directory contains example scripts showing how to use the SDK:

- **Prometheus Bound Demo** - Complete workflow demonstrating:
  - Document upload and chunking
  - Table of contents generation
  - Annotation creation and resolution
  - Event history tracking

```bash
cd demo
cp .env.example .env
npm run pro-bo
```

[→ Read the demo documentation](demo/README.md)

## 🚀 Quickstart

### Prerequisites

- Node.js 18+ (22+ recommended)
- npm 9+
- Docker or Podman (for local PostgreSQL containers)
- AWS CLI configured (for cloud deployment only)

### 1. Clone & Build Semiont CLI

```bash
git clone https://github.com/The-AI-Alliance/semiont.git
cd semiont
export SEMIONT_REPO=$(pwd)      # Set repository path
npm install                     # Install all workspace dependencies
npm run build                   # Build packages and CLI
npm run install:cli             # Install the semiont CLI globally
```

### 2. Create Your Project

```bash
# Create your project directory
cd ..
mkdir my_semiont_project
cd my_semiont_project
export SEMIONT_ROOT=$(pwd)      # Set project root path
export SEMIONT_ENV=local        # Set environment for local development

# Initialize the project with configuration files
semiont init --name "my-project" --environments "local,staging,production"

# This creates:
# ✅ semiont.json - Main project configuration
# ✅ environments/*.json - Environment-specific configs
```

### 3. Local Development

For detailed local development setup, see [LOCAL-DEVELOPMENT.md](docs/LOCAL-DEVELOPMENT.md).

### 4. Deploy to AWS

For complete deployment instructions, see [DEPLOYMENT.md](docs/DEPLOYMENT.md).

## 📖 Documentation

### Development Guides

| Document | Description |
|----------|-------------|
| [LOCAL-DEVELOPMENT.md](docs/LOCAL-DEVELOPMENT.md) | Complete local development setup guide |
| [API Client README](packages/api-client/README.md) | Generated OpenAPI client for external applications |
| [Core SDK README](packages/core/README.md) | Core TypeScript types, schemas, and utilities |
| [Demo README](demo/README.md) | Example scripts demonstrating API client usage |
| [Frontend README](apps/frontend/README.md) | Next.js development guide, patterns, and API integration |
| [Frontend Performance](apps/frontend/docs/PERFORMANCE.md) | Frontend performance optimization guide |
| [Backend README](apps/backend/README.md) | Hono API development guide, type safety, and database patterns |
| [CLI README](apps/cli/README.md) | Semiont CLI command reference, architecture, and development guide |
| [Test Utils README](packages/test-utils/README.md) | Shared testing utilities and mock factories |
| [MCP Server README](packages/mcp-server/README.md) | Model Context Protocol server for AI integration |

### API Specifications

| Document | Description |
|----------|-------------|
| [OpenAPI Specification](specs/openapi.json) | REST API specification (OpenAPI 3.0) - source of truth for API contract |
| [API Reference](specs/docs/API.md) | Complete HTTP API endpoint documentation |
| [W3C Web Annotation](specs/docs/W3C-WEB-ANNOTATION.md) | W3C Web Annotation implementation across all layers |

### System Documentation

| Document | Description |
|----------|-------------|
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Complete deployment guide with validation steps |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture and design decisions |
| [CONFIGURATION.md](docs/CONFIGURATION.md) | Configuration management and environment setup |
| [DATABASE.md](docs/DATABASE.md) | Database setup, migrations, and management |
| [TESTING.md](docs/TESTING.md) | Testing strategy, frameworks, and best practices |

### Operations & Security

| Document | Description |
|----------|-------------|
| [SECURITY.md](docs/SECURITY.md) | Security controls, compliance, and best practices |
| [RBAC.md](docs/RBAC.md) | Role-based access control implementation |
| [SCALING.md](docs/SCALING.md) | Performance scaling and cost optimization |
| [MAINTENANCE.md](docs/MAINTENANCE.md) | Operational maintenance procedures |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common issues and diagnostic commands |

## 📜 License

Apache 2.0 - See [LICENSE](LICENSE) for details.
