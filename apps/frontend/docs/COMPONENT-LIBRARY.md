# Component Library Integration Guide

## Overview

The Semiont frontend leverages **`@semiont/react-ui`**, a framework-
agnostic React component library extracted from the frontend to enable
reuse across different applications and frameworks. This document
explains the package boundary, what lives where, and how the frontend
composes the library.

## Architecture

### Separation of Concerns

```
┌─────────────────────────────────────┐
│         apps/frontend               │
│    (Vite + React Router v7)         │
│                                     │
│  • Routing & pages                  │
│  • Authentication wiring            │
│  • i18next                          │
│  • App-specific composition         │
└─────────────┬───────────────────────┘
              │ uses
              ▼
┌─────────────────────────────────────┐
│    packages/react-ui                │
│  (Framework-agnostic library)       │
│                                     │
│  • UI components                    │
│  • Flow view models (RxJS)          │
│  • Providers and hooks              │
│  • API integration                  │
│  • Semantic CSS (BEM)               │
└─────────────────────────────────────┘
```

### What Lives in `@semiont/react-ui`

#### Components
- **Core UI** — Toolbar, StatusDisplay, Toast, CookiePreferences
- **Resource viewer** — ResourceViewer, ResourceViewerPage
- **Annotation system** — panels (Comments, References, Tags, Assessments, Highlights), entry components, popups
- **Navigation** — Footer, NavigationMenu, SkipLinks, SidebarNavigation, CollapsibleResourceNavigation, SortableResourceTab
- **Modals** — SearchModal, ResourceSearchModal, KeyboardShortcutsHelpModal, SessionExpiredModal, PermissionDeniedModal
- **Layout** — UnifiedHeader, LeftSidebar, PageLayout
- **Session** — SessionTimer, SessionExpiryBanner
- **Branding** — SemiontBranding

#### Hooks and utilities
- `useObservable`, `useBrowseVM`, `useResourceContent`, `useMediaToken`, `useLineNumbers`, `useHoverDelay`, `useKeyboardShortcuts`, `useToast`, `useSessionExpiry`, `useTheme`
- `useEventBus`, `useEventSubscriptions`, `useApiClient`, `useAuthToken`, `useAuthToken$`, `useKnowledgeBaseSession`

#### Providers and contexts
- `EventBusProvider` — per-workspace RxJS EventBus
- `AuthTokenProvider` — holds the token as a `BehaviorSubject<AccessToken | null>`
- `ApiClientProvider` — constructs the `SemiontApiClient` from `baseUrl` + token observable
- `KnowledgeBaseSessionProvider` — active KB + validated session; owns per-KB JWT storage
- `TranslationProvider` — pluggable i18n manager
- `OpenResourcesProvider`, `ResourceAnnotationsProvider` — workspace state

#### Flow view models (from `@semiont/api-client`, re-exported)
- `createMarkVM`, `createGatherVM`, `createMatchVM`, `createYieldVM`, `createBindVM`, `createBeckonVM`, `createBrowseVM`
- Resource-page composition: `createResourceViewerPageVM`

### What Stays in `apps/frontend`

#### Routing and app shell
- Vite + React Router v7 routes
- Locale-scoped layouts (`[locale]/know`, `[locale]/admin`, `[locale]/moderate`)
- `AuthShell` composition and protected boundaries
- Middleware and per-route data loading

#### App-specific pages
- Home, About, Privacy, Terms
- Sign-in / Sign-up / Error pages
- Admin pages (user management, DevOps dashboard)
- Moderation pages (entity tags, schemas)

#### Framework integration
- React Router `Link` component adapter
- Route builders and locale prefixing
- Custom hooks (e.g. `useOpenResourcesManager`) that bridge app state into library providers

## Provider Composition

The frontend mounts library providers directly — there is no app-side
wrapper layer to maintain.

### The Authenticated Provider Stack

```tsx
// apps/frontend/src/app/[locale]/know/layout.tsx (excerpt)
<AuthTokenProvider token={authToken}>
  <ApiClientProvider baseUrl={kbBackendUrl(activeKnowledgeBase)} tokenRefresher={refreshActive}>
    <OpenResourcesProvider openResourcesManager={openResourcesManager}>
      <ResourceAnnotationsProvider>
        {/* page content */}
      </ResourceAnnotationsProvider>
    </OpenResourcesProvider>
  </ApiClientProvider>
</AuthTokenProvider>
```

`EventBusProvider` is mounted higher in the tree (one bus per
workspace). `AuthShell` wraps the whole authenticated subtree:

```tsx
<AuthShell>
  {/* the stack above, including AuthTokenProvider and everything it nests */}
</AuthShell>
```

The library owns provider implementations; the frontend owns the
decision about where to mount them. For the provider API reference
(props, hooks, behavior), see
[`packages/react-ui/docs/PROVIDERS.md`](../../../packages/react-ui/docs/PROVIDERS.md).

## Using Library Components

### Basic usage

```tsx
import { Toolbar, ResourceViewer, useApiClient } from '@semiont/react-ui';
```

Components read from the provider stack via hooks — no explicit props
for the client, event bus, or token. Layouts mount providers once; any
component in the subtree has access.

### Subscribing to observable data

Flow VMs and namespace methods return RxJS Observables. The
`useObservable` hook bridges them into React state:

```tsx
import { useApiClient, useObservable } from '@semiont/react-ui';

function ResourceTitle({ resourceId }) {
  const semiont = useApiClient();
  const resource = useObservable(semiont.browse.resource(resourceId));
  return <h1>{resource?.name}</h1>;
}
```

Cache invalidation, refetching, and bus-driven updates happen inside
`BrowseNamespace` — the component only sees the current value.

### Custom styling

Library components carry semantic CSS class names (BEM-style) with
default styles. Apps layer layout utilities over them; they should not
override component-internal styling.

```tsx
// Good — layout utility only
<Button variant="primary" className="mt-4 w-full">Submit</Button>

// Bad — overrides component styling
<Button variant="primary" className="bg-blue-500">Submit</Button>
```

## Benefits

1. **Framework independence** — `@semiont/react-ui` works with any React framework (Vite, Next.js, etc.). Nothing in the library imports framework-specific modules.
2. **Consistent design system** — shared components and tokens across apps.
3. **Testing split** — components + flow VMs tested in isolation in react-ui; app tests focus on composition.
4. **Clear dependency direction** — `apps/frontend` depends on `@semiont/react-ui`, never the reverse.
5. **Observable-first** — dynamic state is modeled as RxJS Observables end-to-end, so consumers can compose and transform without framework coupling.

## Development Workflow

### Local development

When developing features that span both packages:

```bash
# Watch react-ui for changes
cd packages/react-ui && npm run dev

# Run frontend
cd apps/frontend && npm run dev
```

### Adding components

Decide where the component lives:

- **Framework-agnostic UI, reusable outside the frontend** → `@semiont/react-ui`.
- **App-specific (routing, auth wiring, feature composition)** → `apps/frontend`.

For library components:

1. Create in `packages/react-ui/src/components/`
2. Export from `packages/react-ui/src/index.ts`
3. Add tests in `packages/react-ui/src/components/__tests__/`
4. Add styles in `packages/react-ui/src/styles/`

For frontend components: create in `apps/frontend/src/`, compose
library components as needed, use framework-specific APIs directly.

### Testing strategy

- Unit tests for library components + hooks live in `packages/react-ui`.
- Integration tests (provider stack, page-level behavior) live in `apps/frontend`.
- E2E tests live at the repo root.

## Platform-Agnostic Components

Library components that need framework-specific capabilities accept
them as props rather than importing them. Example — a navigation
component takes a `LinkComponent` prop rather than importing from
`next/link` or `react-router`:

```tsx
import { CollapsibleResourceNavigation } from '@semiont/react-ui';
import { Link } from '@/lib/routing';

<CollapsibleResourceNavigation
  LinkComponent={Link}
  onNavigate={(path) => router.navigate(path)}
  fixedItems={items}
  resources={openResources}
/>
```

Same pattern for icons, date pickers, file uploaders — anything that
would otherwise force a framework dependency.

## Troubleshooting

**Styles not loading**: import the package CSS once in your app entry:

```css
@import '@semiont/react-ui/styles';
```

**Provider errors (`useX must be used within XProvider`)**: check
provider nesting in the layout. Auth-dependent providers must be
inside `AuthShell`.

**Type mismatches after schema changes**: rebuild the core + api-client
packages so the generated OpenAPI types propagate:

```bash
npm run generate:openapi --workspace=@semiont/core
npm run build --workspace=@semiont/core --workspace=@semiont/api-client
```

## Best Practices

1. **Don't duplicate** — if a component exists in `@semiont/react-ui`, use it.
2. **Extend, don't override** — add layout classes, not styling overrides.
3. **Mount providers once** — at the layout level, not in components.
4. **Prefer Observables for shared state** — the library uses RxJS for anything dynamic; stay on that rail.
5. **Test at the right level** — unit in react-ui, integration in frontend.

## Related Documentation

- [`@semiont/react-ui` README](../../../packages/react-ui/README.md)
- [`@semiont/react-ui` providers](../../../packages/react-ui/docs/PROVIDERS.md)
- [`@semiont/react-ui` architecture](../../../packages/react-ui/docs/ARCHITECTURE.md)
- [API Integration](./API-INTEGRATION.md)
- [Frontend Architecture](./ARCHITECTURE.md)
