# Semiont Frontend

A type-safe React frontend built with Next.js 14, featuring W3C Web Annotation support, real-time document collaboration, and AI-powered entity detection and generation.

## Overview

The Semiont frontend provides a rich annotation experience for building semantic knowledge graphs. Users can annotate documents with highlights, entity tags, and document links - all following the W3C Web Annotation Data Model for full interoperability.

**Key Features**:
- W3C Web Annotation compliance
- Markdown documents with wiki-style linking
- AI-powered entity detection (asynchronous)
- AI-powered document generation (asynchronous)
- Type-safe API integration with `@semiont/api-client`
- Real-time progress tracking via Server-Sent Events (SSE)

## Quick Start

### Using Semiont CLI (Recommended)

```bash
# Set your development environment
export SEMIONT_ENV=local

# Start everything (database + backend + frontend)
semiont start

# Your services are now running:
# - Frontend: http://localhost:3000
# - Backend: http://localhost:3001
# - Database: PostgreSQL in Docker container
```

### Manual Setup

```bash
# Install dependencies
npm install

# Start development server (requires backend running)
npm run dev

# Start with mock API (no backend required)
npm run dev:mock
```

**See**: [Development Guide](./docs/DEVELOPMENT.md) for complete setup and workflows.

## Technology Stack

- **Framework**: [Next.js 14](https://nextjs.org/) with App Router
- **UI**: React 18 with TypeScript
- **Styling**: [Tailwind CSS](https://tailwindcss.com/)
- **Authentication**: [NextAuth.js](https://next-auth.js.org/) with Google OAuth
- **State Management**: [TanStack Query](https://tanstack.com/query) (React Query)
- **API Client**: Type-safe client generated from OpenAPI spec
- **Testing**: [Vitest](https://vitest.dev/) + React Testing Library + [MSW v2](https://mswjs.io/)
- **Performance**: Bundle analysis, Lighthouse CI

**Full stack details**: [Frontend Architecture](./docs/ARCHITECTURE.md)

## Project Structure

```
src/
├── app/                # Next.js 14 App Router
│   ├── auth/          # Authentication routes
│   ├── know/          # Document management routes
│   ├── moderate/      # Moderation routes
│   └── admin/         # Admin routes
├── components/         # Reusable UI components
├── hooks/             # Custom React hooks
├── lib/               # Core utilities and API client
├── mocks/             # MSW mock handlers
└── types/             # TypeScript type definitions
```

## Core Features

### Document Management
- Create, search, and view markdown documents
- Wiki-style links (`[[page name]]`) for internal navigation
- Full-text search with real-time results
- Document archiving and cloning

**See**: [Features Guide](./docs/FEATURES.md)

### W3C Web Annotations
- **Highlights**: Mark important text passages
- **Document References**: Link text to other documents (citation, definition, elaboration, etc.)
- **Entity Tags**: Tag text with entity types (Person, Organization, Location, etc.)
- **Multi-body support**: Combine entity tags and document links in one annotation
- **JSON-LD export**: Full W3C compliance for data portability

**See**: [Annotations Guide](./docs/ANNOTATIONS.md), [API Integration Guide](./docs/API-INTEGRATION.md#w3c-web-annotation-model)

### Asynchronous AI Features

Some operations run asynchronously via background job workers:

**Entity Detection** - Find entities in documents using AI:
- Select entity types to detect (Person, Organization, etc.)
- Real-time progress via SSE
- Automatic annotation creation

**Document Generation** - AI-generated documents from annotations:
- Generate document based on annotation context
- Real-time progress via SSE
- Automatic document linking

**See**: [API Integration Guide](./docs/API-INTEGRATION.md#asynchronous-operations) for implementation details.

## Documentation

### Getting Started
- **[Development Guide](./docs/DEVELOPMENT.md)** - Local development, CLI usage, common tasks, debugging
- **[Testing Guide](./docs/TESTING.md)** - Test structure, running tests, writing tests
- **[Deployment Guide](./docs/DEPLOYMENT.md)** - Publishing and deployment workflows

### Architecture & Design
- **[Frontend Architecture](./docs/ARCHITECTURE.md)** - High-level system design, state management, routing
- **[Rendering Architecture](./docs/RENDERING-ARCHITECTURE.md)** - Document rendering pipeline
- **[API Integration](./docs/API-INTEGRATION.md)** - API client usage, async operations, W3C annotations

### Features & UI
- **[Features](./docs/FEATURES.md)** - Document management, annotations, search, AI features
- **[Annotations](./docs/ANNOTATIONS.md)** - W3C annotation system and UI components
- **[Style Guide](./docs/style-guide.md)** - UI/UX patterns and component guidelines

### Security & Auth
- **[Authentication](./docs/AUTHENTICATION.md)** - OAuth, JWT, session management, 401 handling
- **[Authorization](./docs/AUTHORIZATION.md)** - Permission system, 403 error handling

### Performance & Accessibility
- **[Performance Optimization](./docs/PERFORMANCE.md)** - Bundle optimization, Lighthouse CI, monitoring
- **[Keyboard Navigation](./docs/KEYBOARD-NAV.md)** - WCAG 2.1 Level AA compliant keyboard shortcuts

### Specialized Topics
- **[CodeMirror Integration](./docs/CODEMIRROR-INTEGRATION.md)** - Editor implementation details
- **[CodeMirror Widgets](./docs/CODEMIRROR-WIDGETS.md)** - Custom editor widgets
- **[React Markdown](./docs/REACT-MARKDOWN.md)** - Markdown rendering details
- **[Annotation Rendering](./docs/ANNOTATION-RENDERING-PRINCIPLES.md)** - Annotation rendering principles
- **[Adding Languages](./docs/ADDING-LANGUAGE.md)** - Internationalization
- **[Archive & Clone](./docs/ARCHIVE-CLONE.md)** - Document archiving and cloning
- **[Future Implementations](./docs/FUTURE.md)** - Mobile apps, browser extensions, desktop apps, integrations

## Common Commands

```bash
# Development
npm run dev              # Start development server
npm run dev:mock         # Start with mock API (no backend)
npm run build            # Production build

# Testing
npm test                 # Run all tests
npm run test:unit        # Unit tests only
npm run test:integration # Integration tests only
npm run test:coverage    # Tests with coverage report

# Type Checking
npm run type-check       # TypeScript validation

# Performance
npm run perf             # Full performance analysis
npm run analyze          # Bundle size analysis
npm run lighthouse       # Lighthouse CI tests

# Using Semiont CLI
semiont start            # Start all services
semiont test --service frontend  # Run frontend tests
semiont check --service frontend # Check health
```

**See**: [Development Guide](./docs/DEVELOPMENT.md#local-development-with-semiont-cli) for complete CLI usage.

## Contributing

We welcome contributions! Please read:

1. **[Development Guide](./docs/DEVELOPMENT.md)** - Setting up local environment
2. **[Testing Guide](./docs/TESTING.md)** - Writing and running tests
3. **[Style Guide](./docs/style-guide.md)** - UI/UX patterns

**Key Requirements**:
- **Functional, side-effect free code is strongly preferred**
- TypeScript must compile without errors (strict mode)
- All tests must pass
- Include tests for new functionality
- Follow existing patterns in the codebase

### Code Style

- Use functional components with hooks
- Avoid class components and mutations
- Prefer pure functions
- Use descriptive component and variable names
- No unnecessary comments - code should be self-documenting

### Pull Request Requirements

- Tests must pass (all test suites)
- TypeScript must compile without errors (strict mode)
- Follow functional programming principles
- Include tests for new components
- Update documentation if UI changes significantly
- Check bundle size impact with `npm run analyze`

## Quick Links

### System Documentation
- [System Architecture](../../docs/ARCHITECTURE.md) - Overall platform architecture
- [W3C Web Annotation](../../specs/docs/W3C-WEB-ANNOTATION.md) - Annotation data flow across all layers
- [Job Worker](../../docs/services/JOB-WORKER.md) - Background job processing (async operations)

### Other Services
- [Backend README](../backend/README.md) - Backend API server
- [MCP Server README](../../packages/mcp-server/README.md) - AI integration via Model Context Protocol
- [API Client README](../../packages/api-client/README.md) - Type-safe TypeScript client
- [CLI README](../cli/README.md) - Command-line interface

### External Resources
- [Next.js 14 Documentation](https://nextjs.org/docs)
- [NextAuth.js Documentation](https://next-auth.js.org/)
- [TanStack Query Documentation](https://tanstack.com/query)
- [Tailwind CSS Documentation](https://tailwindcss.com/docs)
- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)

---

**Last Updated**: 2025-10-25
**For Help**: See [Documentation](./docs/) or file an issue
