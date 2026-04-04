# Semiont Frontend

A type-safe React SPA built with Vite + React Router, featuring W3C Web Annotation support, real-time document collaboration, and AI-powered annotation detection and generation.

## Overview

The Semiont frontend provides a rich annotation experience for building semantic knowledge graphs. Users can annotate documents with highlights, entity tags, and document links - all following the W3C Web Annotation Data Model for full interoperability.

**Key Features**:
- W3C Web Annotation compliance
- Multi-format document support (text, markdown, images, PDFs)
- Text-based annotations for text/markdown documents
- Spatial annotations for images and PDFs
- AI-powered annotation detection for text (asynchronous)
- AI-powered document generation (asynchronous)
- Type-safe API integration with `@semiont/api-client`
- Real-time progress tracking via Server-Sent Events (SSE)

## npm Package

[![npm version](https://img.shields.io/npm/v/@semiont/frontend.svg)](https://www.npmjs.com/package/@semiont/frontend)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/frontend.svg)](https://www.npmjs.com/package/@semiont/frontend)

The frontend is published as `@semiont/frontend` on npm as a pre-built Vite SPA with a minimal Node.js static file server. It is bundled directly inside `@semiont/cli` — no separate installation step is required. When the CLI starts the frontend service, it runs the bundled `server.js` from its own `node_modules`.

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

## 🐳 Container Image

[![ghcr](https://img.shields.io/badge/ghcr-latest-blue)](https://github.com/The-AI-Alliance/semiont/pkgs/container/semiont-frontend)
[![Accessibility Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/accessibility-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/accessibility-tests.yml)
[![WCAG 2.1 AA](https://img.shields.io/badge/WCAG-2.1%20AA-blue.svg)](https://www.w3.org/WAI/WCAG2AA-Conformance)

Pull and run the published frontend container image:

```bash
# Pull latest development build
docker pull ghcr.io/the-ai-alliance/semiont-frontend:dev

# Run frontend container
docker run -d \
  -p 3000:3000 \
  -e SEMIONT_BACKEND_URL=http://localhost:4000 \
  --name semiont-frontend \
  ghcr.io/the-ai-alliance/semiont-frontend:dev
```

**Required Environment Variables:**
- `SEMIONT_BACKEND_URL` - Backend API URL (e.g., `http://localhost:4000`)
- `SEMIONT_SITE_NAME` - Site name displayed in UI (default: "Semiont")

**Optional Environment Variables:**
- `SEMIONT_GOOGLE_CLIENT_ID` - Google OAuth client ID for authentication
- `SEMIONT_OAUTH_ALLOWED_DOMAINS` - Comma-separated list of allowed email domains
- `SEMIONT_ENABLE_LOCAL_AUTH` - Enable email/password credentials authentication (default: false)

**Multi-platform Support:** linux/amd64, linux/arm64

**Docker Compose Example:** See [docs/administration/IMAGES.md](../../docs/administration/IMAGES.md#docker-compose-example) for complete setup with backend and database.

## Technology Stack

- **Framework**: [Vite](https://vitejs.dev/) + [React Router v7](https://reactrouter.com/)
- **UI**: React 18 with TypeScript
- **Styling**: [Tailwind CSS](https://tailwindcss.com/)
- **i18n**: [i18next](https://www.i18next.com/) + react-i18next
- **State Management**: [TanStack Query](https://tanstack.com/query) (React Query)
- **API Client**: Type-safe client generated from OpenAPI spec
- **Testing**: [Vitest](https://vitest.dev/) + React Testing Library + [MSW v2](https://mswjs.io/)
- **Performance**: Bundle analysis

**Full stack details**: [Frontend Architecture](./docs/ARCHITECTURE.md)

### Component Library

The frontend uses **[@semiont/react-ui](../../packages/react-ui)** - a framework-agnostic React component library providing:

- **Authentication Components**: SignInForm, SignUpForm, AuthErrorDisplay, WelcomePage
- **Layout Components**: PageLayout, UnifiedHeader, LeftSidebar, Footer
- **Resource Components**: ResourceViewer, BrowseView, AnnotateView
- **Format-Specific Viewers**: PdfViewer, PdfAnnotationCanvas for PDF documents
- **Annotation Components**: Annotation panels, toolbars, and widgets
- **React Query Hooks**: Type-safe API integration hooks
- **Built-in Translations**: English and Spanish included with dynamic loading

The library is framework-independent, accepting framework-specific implementations (like Link components) as props. This allows the same components to work with Vite, or any React framework.

### Internationalization

The frontend supports multiple languages through a hybrid approach:

- **Frontend-specific translations**: `apps/frontend/messages-source/*.json` (source of truth)
- **Component translations**: `packages/react-ui/translations/*.json` (source of truth)
- **Generated output**: `scripts/merge-translations.js` merges both into `messages/` and `public/messages/` before every build/test/dev run
- **Dynamic loading**: Non-English locales are loaded on-demand via `i18next-http-backend`

Current supported languages:
- English (en)
- Spanish (es)
- 27+ additional languages (partial coverage)

**See**: [@semiont/react-ui documentation](../../packages/react-ui/README.md)

## Project Structure

```
src/
├── App.tsx             # React Router route tree
├── main.tsx            # Entry point
├── app/[locale]/       # Locale-prefixed page components
│   ├── auth/          # Authentication pages
│   ├── know/          # Document management pages
│   ├── moderate/      # Moderation pages
│   └── admin/         # Admin pages
├── components/         # Reusable UI components
├── hooks/             # Custom React hooks
├── i18n/              # i18next config and routing wrappers
├── lib/               # Core utilities
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

**Annotation Detection** - Detect annotations in documents using AI:
- Multiple detection types: highlights, assessments, comments, tags, entity references
- Real-time progress via SSE
- Automatic annotation creation

**Document Generation** - AI-generated documents from annotations:
- Generate document based on annotation context
- Real-time progress via SSE
- Automatic document linking

**See**: [API Integration Guide](./docs/API-INTEGRATION.md#asynchronous-operations) for implementation details.

## Documentation

### Getting Started
- **[Local Setup](./docs/LOCAL.md)** - Run the frontend locally (container, npm, or desktop app)
- **[Development Guide](./docs/DEVELOPMENT.md)** - Local development, CLI usage, common tasks, debugging
- **[Testing Guide](./docs/TESTING.md)** - Test structure, running tests, writing tests
- **[Deployment Guide](./docs/DEPLOYMENT.md)** - Publishing and deployment workflows

### Architecture & Design
- **[Frontend Architecture](./docs/ARCHITECTURE.md)** - High-level system design, state management, routing
- **[Rendering Architecture](../../packages/react-ui/docs/RENDERING-ARCHITECTURE.md)** - Document rendering pipeline
- **[API Integration](./docs/API-INTEGRATION.md)** - API client usage, async operations, W3C annotations

### Features & UI
- **[Features](./docs/FEATURES.md)** - Document management, annotations, search, AI features
- **[Annotations](./docs/ANNOTATIONS.md)** - W3C annotation system and UI components
- **[Style Guide](./docs/style-guide.md)** - UI/UX patterns and component guidelines

### Security & Auth
- **[Authentication](./docs/AUTHENTICATION.md)** - OAuth, JWT, session management, 401 handling
- **[Authorization](./docs/AUTHORIZATION.md)** - Permission system, 403 error handling

### Performance & Accessibility
- **[Performance Optimization](./docs/PERFORMANCE.md)** - Bundle optimization, monitoring
- **[Accessibility](./docs/ACCESSIBILITY.md)** - WCAG 2.1 Level AA compliance, screen reader support, testing
- **[Keyboard Navigation](./docs/KEYBOARD-NAV.md)** - WCAG 2.1 Level AA compliant keyboard shortcuts

### Specialized Topics
- **[CodeMirror Integration](../../packages/react-ui/docs/CODEMIRROR-INTEGRATION.md)** - Editor implementation details
- **[CodeMirror Widgets](../../packages/react-ui/docs/CODEMIRROR-WIDGETS.md)** - Custom editor widgets
- **[Annotation Overlay](../../ANNOTATION-OVERLAY.md)** - BrowseView annotation rendering (DOM Range overlay)
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
- [Jobs Package](../../packages/jobs/) - Background job processing (async operations)

### Other Services
- [Backend README](../backend/README.md) - Backend API server
- [MCP Server README](../../packages/mcp-server/README.md) - AI integration via Model Context Protocol
- [API Client README](../../packages/api-client/README.md) - Type-safe TypeScript client
- [CLI README](../cli/README.md) - Command-line interface

### External Resources
- [Vite Documentation](https://vitejs.dev/)
- [React Router v7 Documentation](https://reactrouter.com/)
- [i18next Documentation](https://www.i18next.com/)
- [TanStack Query Documentation](https://tanstack.com/query)
- [Tailwind CSS Documentation](https://tailwindcss.com/docs)
- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)

---

**Last Updated**: 2026-03-29
**For Help**: See [Documentation](./docs/) or file an issue
