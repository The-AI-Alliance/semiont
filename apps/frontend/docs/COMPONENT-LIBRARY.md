# Component Library Integration Guide

## Overview

The Semiont frontend leverages **@semiont/react-ui**, a framework-agnostic React component library that was factored out from the frontend to enable reuse across different applications and frameworks. This document explains how the frontend integrates with and uses this component library.

## Architecture Impact

### Separation of Concerns

The factoring of @semiont/react-ui creates a clear architectural boundary:

```
┌─────────────────────────────────────┐
│         apps/frontend               │
│  (Next.js specific implementation)  │
│                                     │
│  • Routing & Pages                  │
│  • Authentication (NextAuth)        │
│  • i18n (next-intl)                │
│  • App-specific components          │
│  • Tailwind for layouts            │
└─────────────┬───────────────────────┘
              │ uses
              ▼
┌─────────────────────────────────────┐
│    packages/react-ui                │
│  (Framework-agnostic library)       │
│                                     │
│  • Core UI Components               │
│  • Hooks & Utilities                │
│  • Provider Pattern                 │
│  • API Integration                  │
│  • Semantic CSS (BEM)              │
└─────────────────────────────────────┘
```

### What Moved to @semiont/react-ui

#### Components
- **Core UI Components**: Button, Card, Toolbar, StatusDisplay, Toast
- **Resource Components**: ResourceViewer, AnnotateView, BrowseView
- **Annotation System**: All annotation components and popups
- **Panels**: All resource panels (Comments, References, Tags, etc.)
- **Navigation**:
  - Footer, NavigationMenu, SkipLinks
  - **SidebarNavigation**: Reusable sidebar navigation for admin/moderation
  - **CollapsibleResourceNavigation**: Full-featured collapsible navigation with drag & drop
  - **SortableResourceTab**: Draggable resource tabs with sorting
- **Modals**:
  - **SearchModal**: Global search with navigation
  - **ResourceSearchModal**: Resource-specific search modal
  - KeyboardShortcutsHelpModal, ProposeEntitiesModal
- **Layout Components**: UnifiedHeader, LeftSidebar, PageLayout
- **Branding**: SemiontBranding component
- **Session Components**: SessionTimer, SessionExpiryBanner

#### Hooks
- **API Hooks**: All React Query wrappers for API operations
- **UI Hooks**: useTheme, useKeyboardShortcuts, useToast
- **Resource Hooks**: useResourceEvents, useDetectionProgress
- **Form Hooks**: useFormValidation, useDebounce

#### Contexts & Providers
- **ApiClientProvider**: Manages API client instance
- **SessionProvider**: Manages user session state
- **TranslationProvider**: Manages i18n translations
- **AnnotationProvider**: Manages annotation state
- **CacheProvider**: Manages client-side caching

#### Utilities
- **Annotation Registry**: Centralized annotation type management
- **Query Keys**: Consistent React Query key management
- **Validation**: Form validation rules and utilities
- **CodeMirror Extensions**: Custom editor widgets and themes

### What Stays in Frontend

#### Next.js Specific
- **Pages & Routing**: All Next.js app router pages
- **API Routes**: Server-side API endpoints
- **Middleware**: Authentication and locale detection
- **next.config.js**: Next.js configuration

#### App-Specific Components
- **Page Components**: Home, About, Privacy, Terms pages
- **Auth Pages**: Sign-in, Sign-up, Error pages
- **Admin Pages**: User management, DevOps dashboard
- **Moderation Pages**: Entity tags, schemas management

#### Integration Layer
- **Provider Implementations**: Next.js specific implementations of provider interfaces
- **Link Components**: Next.js Link wrapper for routing
- **Image Optimization**: Next.js Image component usage

## Provider Pattern Implementation

The frontend implements the provider interfaces defined by @semiont/react-ui:

### Session Provider

```tsx
// app/providers/SessionProvider.tsx
import { SessionProvider } from '@semiont/react-ui';
import { useSession } from 'next-auth/react';

export function NextAuthSessionProvider({ children }) {
  const session = useSession();

  const sessionManager = {
    getSession: () => session.data,
    signIn: (credentials) => signIn('credentials', credentials),
    signOut: () => signOut(),
    onSessionChange: (callback) => {
      // Subscribe to NextAuth session changes
    }
  };

  return (
    <SessionProvider sessionManager={sessionManager}>
      {children}
    </SessionProvider>
  );
}
```

### Translation Provider

```tsx
// app/providers/TranslationProvider.tsx
import { TranslationProvider } from '@semiont/react-ui';
import { useTranslations as useNextIntl } from 'next-intl';

export function NextIntlTranslationProvider({ children }) {
  const t = useNextIntl();

  const translationManager = {
    t: (key, params) => t(key, params),
    locale: 'en',
    setLocale: (locale) => {
      // Handle locale change with Next.js routing
    }
  };

  return (
    <TranslationProvider translationManager={translationManager}>
      {children}
    </TranslationProvider>
  );
}
```

### API Client Provider

```tsx
// app/providers/ApiClientProvider.tsx
import { ApiClientProvider } from '@semiont/react-ui';
import { createApiClient } from '@semiont/api-client';

export function AppApiClientProvider({ children }) {
  const apiClientManager = {
    getClient: () => createApiClient({
      baseURL: process.env.NEXT_PUBLIC_API_URL,
      getToken: async () => {
        const session = await getSession();
        return session?.accessToken;
      }
    })
  };

  return (
    <ApiClientProvider apiClientManager={apiClientManager}>
      {children}
    </ApiClientProvider>
  );
}
```

## Using Components from @semiont/react-ui

### Basic Component Usage

```tsx
import { Button, Card, ResourceViewer } from '@semiont/react-ui';

export function MyPage() {
  return (
    <Card>
      <Card.Header>
        <h2>My Resource</h2>
      </Card.Header>
      <Card.Content>
        <ResourceViewer resourceId="123" />
        <Button variant="primary" onClick={handleSave}>
          Save Changes
        </Button>
      </Card.Content>
    </Card>
  );
}
```

### Using Hooks

```tsx
import { useResources, useToast } from '@semiont/react-ui';

export function ResourceList() {
  const { showToast } = useToast();
  const resources = useResources();

  const { data, isLoading } = resources.list.useQuery();

  const createMutation = resources.create.useMutation({
    onSuccess: () => {
      showToast('Resource created successfully', 'success');
    }
  });

  // Component logic...
}
```

### Custom Styling Integration

Components from @semiont/react-ui come with semantic CSS classes. You can add additional Tailwind classes for spacing and layout:

```tsx
import { Button } from '@semiont/react-ui';

// Good - adds layout utilities
<Button variant="primary" className="mt-4 w-full">
  Submit
</Button>

// Bad - overrides component styling
<Button variant="primary" className="bg-blue-500 hover:bg-blue-600">
  Submit
</Button>
```

## Migration from Monolithic Frontend

### Before (Everything in Frontend)

```tsx
// components/Button.tsx - in frontend
export function Button({ children, ...props }) {
  return (
    <button className="px-4 py-2 bg-blue-500 text-white rounded">
      {children}
    </button>
  );
}

// pages/resource.tsx
import { Button } from '../components/Button';
```

### After (Using @semiont/react-ui)

```tsx
// No Button.tsx in frontend anymore

// pages/resource.tsx
import { Button } from '@semiont/react-ui';

// Button now has semantic CSS from react-ui
<Button variant="primary">Click me</Button>
```

## Benefits of This Architecture

### 1. **Framework Independence**
- @semiont/react-ui can be used with any React framework
- Not tied to Next.js, NextAuth, or next-intl
- Enables building Vite, CRA, or Remix apps with same components

### 2. **Consistent Design System**
- All apps using @semiont/react-ui share the same components
- Centralized design tokens and styling
- Consistent behavior and accessibility features

### 3. **Improved Testing**
- Component library has its own comprehensive test suite
- Frontend only needs to test app-specific logic
- Over 1250 tests in @semiont/react-ui

### 4. **Better Separation of Concerns**
- Clear boundary between framework code and UI components
- Easier to reason about dependencies
- Simplified maintenance and updates

### 5. **Type Safety**
- Shared TypeScript types between frontend and library
- Consistent API interfaces
- Better IDE support and autocomplete

## Development Workflow

### Local Development

When developing features that span both packages:

```bash
# Terminal 1 - Watch react-ui for changes
cd packages/react-ui
npm run dev

# Terminal 2 - Run frontend with hot reload
cd apps/frontend
npm run dev
```

### Adding New Components

1. **Determine Location**:
   - Framework-agnostic? → Add to @semiont/react-ui
   - Next.js specific? → Keep in frontend

2. **For @semiont/react-ui Components**:
   ```bash
   cd packages/react-ui
   # Create component in src/components/
   # Export from src/index.ts
   # Add tests in src/components/__tests__/
   # Add styles in src/styles/
   ```

3. **For Frontend Components**:
   ```bash
   cd apps/frontend
   # Create in src/components/
   # Use Tailwind for styling
   # Import react-ui components as needed
   ```

### Testing Strategy

```bash
# Test react-ui components
cd packages/react-ui
npm test

# Test frontend integration
cd apps/frontend
npm test

# E2E tests (frontend)
npm run test:e2e
```

## Common Patterns

### Platform-Agnostic Navigation Pattern

The new navigation components demonstrate best practices for platform-agnostic design:

```tsx
// Example: Using CollapsibleResourceNavigation
import { CollapsibleResourceNavigation } from '@semiont/react-ui';
import { Link } from '@/i18n/routing'; // Next.js specific
import { ChevronLeftIcon, Bars3Icon } from '@heroicons/react/24/outline'; // Icons passed as props

export function KnowledgeNavigation() {
  // Platform-specific routing
  const router = useRouter();

  return (
    <CollapsibleResourceNavigation
      // Pass platform-specific components as props
      LinkComponent={Link}
      icons={{
        chevronLeft: ChevronLeftIcon,
        bars: Bars3Icon
      }}
      // Handle navigation with platform-specific router
      onNavigate={(path) => router.push(path)}
      // All other props are platform-agnostic
      fixedItems={navigationItems}
      resources={openResources}
    />
  );
}
```

This pattern allows the same component to work in:
- Next.js apps (with next/link)
- Vite apps (with react-router)
- Mobile apps (with react-navigation)
- Desktop apps (with electron routing)

### Wrapping react-ui Components

Sometimes you need to add app-specific behavior:

```tsx
// components/AppButton.tsx
import { Button } from '@semiont/react-ui';
import { useRouter } from 'next/router';

export function AppButton({ href, ...props }) {
  const router = useRouter();

  if (href) {
    return (
      <Button {...props} onClick={() => router.push(href)} />
    );
  }

  return <Button {...props} />;
}
```

### Composing Complex Features

```tsx
import {
  ResourceViewer,
  useResources,
  AnnotationProvider
} from '@semiont/react-ui';

export function ResourcePage({ id }) {
  // App-specific logic
  const { data: resource } = useResources().get.useQuery(id);

  // Compose with react-ui components
  return (
    <AnnotationProvider resourceId={id}>
      <div className="flex gap-4"> {/* Tailwind for layout */}
        <main className="flex-1">
          <ResourceViewer resource={resource} />
        </main>
        <aside className="w-80">
          {/* App-specific sidebar */}
        </aside>
      </div>
    </AnnotationProvider>
  );
}
```

## Troubleshooting

### Component Styles Not Loading

**Problem**: @semiont/react-ui components appear unstyled

**Solution**: Ensure CSS is imported in globals.css:
```css
@import '@semiont/react-ui/styles';
```

### TypeScript Errors

**Problem**: Types not found from @semiont/react-ui

**Solution**: Rebuild the package:
```bash
cd packages/react-ui
npm run build
```

### Provider Errors

**Problem**: "useTranslations must be used within TranslationProvider"

**Solution**: Ensure all providers are properly wrapped in _app.tsx or layout.tsx

## Best Practices

1. **Don't Duplicate**: If a component exists in @semiont/react-ui, use it
2. **Extend, Don't Override**: Add classes for layout, not styling
3. **Follow the Pattern**: Use provider pattern for framework integration
4. **Test at the Right Level**: Unit test in react-ui, integration test in frontend
5. **Document Decisions**: Clear comments when choosing location for new code

## Related Documentation

- [@semiont/react-ui README](../../../packages/react-ui/README.md)
- [@semiont/react-ui Provider Patterns](../../../packages/react-ui/docs/PROVIDERS.md)
- [Style Guide](./style-guide.md)
- [API Integration](./API-INTEGRATION.md)
- [Architecture](./ARCHITECTURE.md)