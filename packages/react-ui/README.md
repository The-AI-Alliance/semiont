# @semiont/react-ui

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+react-ui%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=react-ui)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=react-ui)
[![npm version](https://img.shields.io/npm/v/@semiont/react-ui.svg)](https://www.npmjs.com/package/@semiont/react-ui)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/react-ui.svg)](https://www.npmjs.com/package/@semiont/react-ui)
[![License](https://img.shields.io/npm/l/@semiont/react-ui.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)
[![Accessibility Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/accessibility-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/accessibility-tests.yml)
[![WCAG 2.1 AA](https://img.shields.io/badge/WCAG-2.1%20AA-blue.svg)](https://www.w3.org/WAI/WCAG2AA-Conformance)

Framework-agnostic React component library for building Semiont knowledge management applications.

## Overview

`@semiont/react-ui` provides reusable React components, hooks, and utilities for creating Semiont applications. The library is designed to be **completely framework-agnostic**, working seamlessly with Next.js, Create React App, Vite, Remix, or any other React framework.

## Key Features

- **Framework Independence** - Zero dependencies on Next.js, next-auth, or next-intl
- **Component Composition** - Components accept framework-specific implementations (Link, routing) as props
- **Provider Pattern** - Consistent approach for session, translations, and routing
- **SDK Live Queries** - Read data with `useObservable()` over the SDK's read-through cache; no bespoke fetching layer
- **Authentication Components** - Sign-in, sign-up, and error display components
- **Navigation Components** - Collapsible sidebar with drag & drop resource tabs
- **Modal Components** - Global search and resource selection modals
- **Accessibility First** - WCAG compliant with keyboard navigation, screen reader support
- **Comprehensive Testing** - 1250+ tests with extensive coverage
- **Annotation System** - Rich annotation and tagging capabilities
- **Built-in Translations** - English and Spanish included, with dynamic loading for optimal bundle size
- **Flexible i18n** - Three modes: default English, built-in locales, or custom translation system
- **Favicon Assets** - Complete set of Semiont branded favicons for all platforms

## Installation

```bash
npm install @semiont/react-ui @semiont/sdk @semiont/core
```

`@semiont/sdk` is the primary dependency — it provides the `SemiontBrowser`,
`SemiontClient`, the read-through cache, and the state machinery that
`@semiont/react-ui` renders. `@semiont/core` provides the shared API types.

### Peer Dependencies

```json
{
  "react": "^19.0.0",
  "react-dom": "^19.0.0"
}
```

### CSS Setup

Import the styles in your app's main CSS file:

```css
/* Your app's main CSS file (e.g., globals.css, app.css) */
@import '@semiont/react-ui/styles';
```

**Requirements:**
- Your build system must support PostCSS with `postcss-import` plugin
- This is standard in Next.js, Vite, and most modern build tools
- The package exports source CSS files, which your build system will process

**What this does:**
- Imports all component styles, design tokens, and CSS variables
- Your build tool processes the `@import` statements and bundles the CSS
- No additional configuration needed in most frameworks

## Quick Start

### 1. Set Up Providers

```tsx
import {
  SemiontProvider,
  TranslationProvider,
  ProtectedErrorBoundary,
  SessionExpiredModal,
  PermissionDeniedModal,
} from '@semiont/react-ui';

function App({ children }) {
  const translationManager = useTranslationManager(); // Your implementation

  return (
    <TranslationProvider translationManager={translationManager}>
      {/* SemiontProvider puts the SemiontBrowser singleton into context.
          useSemiont() hands it back; the active SemiontSession (and its
          SemiontClient) flow from there. */}
      <SemiontProvider>
        <ProtectedErrorBoundary>
          <SessionExpiredModal />
          <PermissionDeniedModal />
          {children}
        </ProtectedErrorBoundary>
      </SemiontProvider>
    </TranslationProvider>
  );
}
```

### 2. Use Components

```tsx
import { ResourceViewer, useSemiont, useObservable } from '@semiont/react-ui';

function MyComponent() {
  const semiont = useObservable(useSemiont().activeSession$)?.client;
  // browse.resources() is an SDK live query backed by the read-through cache.
  const resources = useObservable(semiont?.browse.resources({ limit: 20 }));

  if (!resources) return <div>Loading...</div>;

  return <ResourceViewer resource={resources[0]} />;
}
```

### 3. Use Translations

```tsx
import { useTranslations } from '@semiont/react-ui';

// Option 1: Default English (no provider needed)
function Toolbar() {
  const t = useTranslations('Toolbar');
  return <button>{t('save')}</button>;
}

// Option 2: Built-in locales
import { TranslationProvider } from '@semiont/react-ui';

function App() {
  return (
    <TranslationProvider locale="es">
      <Toolbar />
    </TranslationProvider>
  );
}

// Option 3: Custom translation system
const myTranslationManager = {
  t: (namespace, key, params) => myI18n.translate(`${namespace}.${key}`, params)
};

function App() {
  return (
    <TranslationProvider translationManager={myTranslationManager}>
      <Toolbar />
    </TranslationProvider>
  );
}
```

## Favicon Assets

The package includes Semiont-branded favicons in multiple formats (SVG, PNG, ICO) and a React component for inline usage. See [docs/FAVICON.md](docs/FAVICON.md) for complete usage instructions.

## Architecture

The library follows strict architectural principles:

- **No Aliasing or Wrappers** - Direct API access, no compatibility layers
- **Provider Pattern** - Consistent dependency injection via React Context
- **Framework Agnostic** - Apps provide framework-specific implementations
- **TypeScript First** - Full type safety throughout

## CSS Architecture

The styles are organized into a modular, maintainable structure:

- **Design Tokens** - Centralized variables for consistent theming
- **Core UI Elements** - Fundamental, reusable components (buttons, toggles, sliders, etc.)
- **W3C Motivations** - Dedicated styles for Web Annotation standard motivations
- **Component/Panel Separation** - Complex components vs. layout containers
- **Dark Theme Support** - Comprehensive dark mode using `[data-theme="dark"]`

Key directories:
- `styles/core/` - Fundamental UI elements (buttons, toggles, progress bars, sliders, badges, tags, indicators)
- `styles/motivations/` - W3C Web Annotation motivation styles (reference, highlight, assessment, comment, tag)
- `styles/components/` - Complex, composed components
- `styles/panels/` - Panel layouts and containers
- `styles/features/` - Feature-specific styling

See [docs/STYLES.md](docs/STYLES.md) for detailed CSS documentation.

## Core Concepts

### Providers

Cross-cutting concerns use the Provider Pattern:

- **SemiontProvider** - The single React provider for session state. Puts the module-scoped `SemiontBrowser` singleton into context; `useSemiont()` returns it. The browser owns the KB list, active KB, and validated session lifecycle — it's the single source of truth for "which KB and what's the session against it." The active `SemiontSession` (and its `SemiontClient`) flow from `browser.activeSession$`.
- **TranslationProvider** - Internationalization
- **RoutingContext** - Framework-agnostic navigation

See [docs/SESSION.md](docs/SESSION.md) for details.

### Page state machines

`@semiont/react-ui` houses the framework-neutral state machinery for the Semiont web frontend's specific pages and shell. These are RxJS-based factories (no React inside; pure observables and async functions) but they're shaped around the web frontend's page taxonomy, so they belong with the components that render them rather than in `@semiont/sdk`:

- **Shell** — `createShellStateUnit` (toolbar panel state with `'knowledge-base' | 'common' | 'resource'` taxonomy), `createSessionStateUnit` (session-scoped logout)
- **Pages** — `createComposePageStateUnit`, `createResourceViewerPageStateUnit`, `createResourceLoaderStateUnit`
- **Admin** — `createAdminUsersStateUnit`, `createAdminSecurityStateUnit`, `createExchangeStateUnit` (backup/restore + import/export)
- **Auth + discovery + moderation** — `createWelcomeStateUnit`, `createDiscoverStateUnit`, `createEntityTagsStateUnit`

Adjacent to the state units: `useKBDiscovery` binds the sdk's
launcher-KB discovery subscription (`subscribeDiscovery`) to React state —
see [SESSION.md](docs/SESSION.md#usekbdiscovery--launcher-published-kbs).

Each lives in `src/features/<feature>/state/` (or `src/state/` for cross-feature ones) next to the components that consume it. The `useStateUnit` hook wires them into React lifecycles.

Use them via `import { createComposePageStateUnit } from '@semiont/react-ui'`. UI-shape-neutral state machines (flow VMs, worker adapters, search pipeline) continue to live in `@semiont/sdk` and are re-exported from here for convenience.

### API Integration

Data fetching and caching are an SDK concern. The SDK exposes an RxJS
read-through cache (stale-while-revalidate); react-ui consumes it as live
queries via `useObservable()`. Reads come from `client.browse.*(...)`
observables; writes go through the typed namespaces (`client.mark.*`,
`client.bind.*`, etc.).

```tsx
import { useSemiont, useObservable } from '@semiont/react-ui';

function Example() {
  const client = useObservable(useSemiont().activeSession$)?.client;

  // Read: live query over the read-through cache
  const resources = useObservable(client?.browse.resources({ limit: 10 }));

  // Write: typed namespace call (cache invalidation is handled by the SDK)
  const archive = (rUri) => client?.mark.archive(rUri);
}
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

- [SESSION.md](docs/SESSION.md) - Provider Pattern and manager interfaces
- [INTERNATIONALIZATION.md](docs/INTERNATIONALIZATION.md) - Translation approach
- [TESTING.md](docs/TESTING.md) - Testing utilities and patterns
- [API-INTEGRATION.md](docs/API-INTEGRATION.md) - Working with the Semiont API
- [COMPONENTS.md](docs/COMPONENTS.md) - Component library reference
- [navigation-components.md](docs/navigation-components.md) - Navigation components (SidebarNavigation, CollapsibleResourceNavigation)
- [modal-components.md](docs/modal-components.md) - Modal components (SearchModal, ResourceSearchModal)
- [ROUTING.md](docs/ROUTING.md) - Framework-agnostic routing
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) - Design principles and decisions
- [STYLES.md](docs/STYLES.md) - CSS architecture and styling guide
- [FAVICON.md](docs/FAVICON.md) - Favicon assets and usage
- [ANNOTATIONS.md](docs/ANNOTATIONS.md) - Annotation system (coming soon)
- [ACCESSIBILITY.md](docs/ACCESSIBILITY.md) - Accessibility architecture and WCAG compliance

## Examples

### Next.js Integration

```tsx
// app/providers.tsx
'use client';

import { useLocale } from 'next-intl';
import { TranslationProvider, SemiontProvider } from '@semiont/react-ui';

export function useTranslationManager() {
  const locale = useLocale();
  const messages = require(`@/messages/${locale}.json`);

  return {
    t: (namespace, key) => messages[namespace]?.[key] || key
  };
}

export function Providers({ children }) {
  const translationManager = useTranslationManager();

  // SemiontProvider defaults to the canonical web setup (WebBrowserStorage +
  // an HTTP session factory). It reads the module-scoped SemiontBrowser
  // singleton via getBrowser() — no client construction here. Sign-in flows
  // adopt the OAuth session onto the browser; browser.activeSession$ then
  // carries the live SemiontClient.
  return (
    <TranslationProvider translationManager={translationManager}>
      <SemiontProvider>{children}</SemiontProvider>
    </TranslationProvider>
  );
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

See [CONTRIBUTING.md](../../CONTRIBUTING.md) in the repository root for full guidelines.

## License

[License information to be added]

## Related Packages

- [@semiont/sdk](../sdk) - `SemiontBrowser`, `SemiontClient`, the read-through cache, and the state machinery. Its [**Developer Guide**](../sdk/docs/DEVELOPER-GUIDE.md) covers end-to-end use, including embedding this package's `ResourceViewer`.
- [@semiont/core](../core) - Shared API types (`components`) generated from the OpenAPI spec
- [@semiont/http-transport](../http-transport) - HTTP transport (`HttpTransport`, `HttpContentTransport`, `APIError`)
- [semiont-frontend](../../apps/frontend) - Reference Next.js implementation
