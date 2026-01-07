# @semiont/react-ui

[![npm version](https://img.shields.io/npm/v/@semiont/react-ui)](https://www.npmjs.com/package/@semiont/react-ui)
[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+react-ui%22)
[![Accessibility Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/accessibility-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/accessibility-tests.yml)
[![WCAG 2.1 AA](https://img.shields.io/badge/WCAG-2.1%20AA-blue.svg)](https://www.w3.org/WAI/WCAG2AA-Conformance)

Framework-agnostic React component library for building Semiont knowledge management applications.

## Overview

`@semiont/react-ui` provides reusable React components, hooks, and utilities for creating Semiont applications. The library is designed to be **completely framework-agnostic**, working seamlessly with Next.js, Create React App, Vite, Remix, or any other React framework.

## Key Features

- **Framework Independence** - Zero dependencies on Next.js, next-auth, or next-intl
- **Component Composition** - Components accept framework-specific implementations (Link, routing) as props
- **Provider Pattern** - Consistent approach for session, translations, API client, and routing
- **Type-Safe API Hooks** - React Query wrappers for all Semiont API operations
- **Authentication Components** - Sign-in, sign-up, and error display components
- **Accessibility First** - WCAG compliant with keyboard navigation, screen reader support
- **Comprehensive Testing** - 800+ tests with extensive coverage
- **Annotation System** - Rich annotation and tagging capabilities

## Installation

```bash
npm install @semiont/react-ui @semiont/api-client @tanstack/react-query
```

### Peer Dependencies

```json
{
  "react": "^18.0.0",
  "react-dom": "^18.0.0",
  "@tanstack/react-query": "^5.0.0",
  "@semiont/api-client": "*"
}
```

## Quick Start

### 1. Set Up Providers

```tsx
import {
  TranslationProvider,
  ApiClientProvider,
  SessionProvider,
} from '@semiont/react-ui';
import { QueryClientProvider } from '@tanstack/react-query';

function App({ children }) {
  const translationManager = useTranslationManager(); // Your implementation
  const apiClientManager = useApiClientManager();     // Your implementation
  const sessionManager = useSessionManager();         // Your implementation
  const queryClient = new QueryClient();

  return (
    <SessionProvider sessionManager={sessionManager}>
      <TranslationProvider translationManager={translationManager}>
        <ApiClientProvider apiClientManager={apiClientManager}>
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        </ApiClientProvider>
      </TranslationProvider>
    </SessionProvider>
  );
}
```

### 2. Use Components

```tsx
import { ResourceViewer, useResources } from '@semiont/react-ui';

function MyComponent() {
  const resources = useResources();
  const { data, isLoading } = resources.list.useQuery();

  if (isLoading) return <div>Loading...</div>;

  return <ResourceViewer resource={data[0]} />;
}
```

### 3. Use Translations

```tsx
import { useTranslations } from '@semiont/react-ui';

function Toolbar() {
  const t = useTranslations('Toolbar');

  return (
    <button>{t('save')}</button>
  );
}
```

## Architecture

The library follows strict architectural principles:

- **No Aliasing or Wrappers** - Direct API access, no compatibility layers
- **Provider Pattern** - Consistent dependency injection via React Context
- **Framework Agnostic** - Apps provide framework-specific implementations
- **TypeScript First** - Full type safety throughout

## Core Concepts

### Providers

All cross-cutting concerns use the Provider Pattern:

- **SessionProvider** - Authentication state management
- **TranslationProvider** - Internationalization
- **ApiClientProvider** - Authenticated API client
- **OpenResourcesProvider** - Recently opened resources
- **RoutingContext** - Framework-agnostic navigation

See [docs/PROVIDERS.md](docs/PROVIDERS.md) for details.

### API Integration

React Query hooks for all API operations:

```tsx
import { useResources, useAnnotations, useEntityTypes } from '@semiont/react-ui';

// List resources
const resources = useResources();
const { data } = resources.list.useQuery({ limit: 10 });

// Create annotation
const annotations = useAnnotations();
const { mutate } = annotations.create.useMutation();
```

See [docs/API-INTEGRATION.md](docs/API-INTEGRATION.md) for details.

### Testing

Comprehensive test utilities included:

```tsx
import { renderWithProviders } from '@semiont/react-ui/test-utils';

it('should render component', () => {
  renderWithProviders(<MyComponent />);
  expect(screen.getByText('Hello')).toBeInTheDocument();
});
```

See [docs/TESTING.md](docs/TESTING.md) for details.

## Documentation

- [PROVIDERS.md](docs/PROVIDERS.md) - Provider Pattern and manager interfaces
- [INTERNATIONALIZATION.md](docs/INTERNATIONALIZATION.md) - Translation approach
- [TESTING.md](docs/TESTING.md) - Testing utilities and patterns
- [API-INTEGRATION.md](docs/API-INTEGRATION.md) - Working with the Semiont API
- [COMPONENTS.md](docs/COMPONENTS.md) - Component library reference
- [ROUTING.md](docs/ROUTING.md) - Framework-agnostic routing
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) - Design principles and decisions
- [ANNOTATIONS.md](docs/ANNOTATIONS.md) - Annotation system (coming soon)

## Examples

### Next.js Integration

```tsx
// app/providers.tsx
'use client';

import { useSession } from 'next-auth/react';
import { useLocale } from 'next-intl';
import { SemiontApiClient } from '@semiont/api-client';
import { TranslationProvider, ApiClientProvider } from '@semiont/react-ui';

export function useTranslationManager() {
  const locale = useLocale();
  const messages = require(`@/messages/${locale}.json`);

  return {
    t: (namespace, key) => messages[namespace]?.[key] || key
  };
}

export function useApiClientManager() {
  const { data: session } = useSession();

  return {
    client: session?.backendToken
      ? new SemiontApiClient({ accessToken: session.backendToken })
      : null
  };
}
```

### Vite Integration

```tsx
// src/App.tsx
import { useState } from 'react';
import { TranslationProvider } from '@semiont/react-ui';

function useTranslationManager() {
  const [locale] = useState('en');

  return {
    t: (namespace, key) => `${namespace}.${key}` // Your i18n library
  };
}

function App() {
  const translationManager = useTranslationManager();

  return (
    <TranslationProvider translationManager={translationManager}>
      {/* Your app */}
    </TranslationProvider>
  );
}
```

## Development

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Type checking
npm run typecheck
```

## Contributing

This library follows strict quality standards:

- **100% TypeScript** - All code must be properly typed
- **No `any` casts** - Without explicit permission
- **No cruft** - Delete dead code immediately, no "legacy" patterns
- **Direct fixes** - If something is wrong, fix it directly (no aliases/wrappers)

See [CLAUDE.md](../../CLAUDE.md) in the repository root for full guidelines.

## License

[License information to be added]

## Related Packages

- [@semiont/api-client](../api-client) - TypeScript client for Semiont API
- [semiont-frontend](../../apps/frontend) - Reference Next.js implementation
