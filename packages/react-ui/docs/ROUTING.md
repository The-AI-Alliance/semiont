# Routing

Framework-agnostic routing approach using the Provider Pattern.

## Overview

`@semiont/react-ui` doesn't assume any specific routing library. Instead, apps provide their routing implementation via `RoutingContext`.

This allows the library to:
- ✅ Work with **any routing library** (Next.js Router, React Router, Wouter, etc.)
- ✅ Support **any routing pattern** (file-based, config-based, etc.)
- ✅ Enable **server-side or client-side routing**
- ✅ Allow **custom route structures**

## Setup

### 1. Define Routing Configuration

```typescript
import { RoutingConfig } from '@semiont/react-ui';

interface RoutingConfig {
  Link: ComponentType<{
    href: string;
    children: ReactNode;
    [key: string]: any; // Additional props like className, onClick, etc.
  }>;
  routes: {
    home: string;
    discover: string;
    resource: (id: string) => string;
    moderate: string;
    administer: string;
    [key: string]: string | ((...args: any[]) => string);
  };
}
```

### 2. Provide to App

```tsx
import { RoutingProvider } from '@semiont/react-ui';

const routingConfig: RoutingConfig = {
  Link: YourLinkComponent,
  routes: {
    home: '/',
    discover: '/discover',
    resource: (id) => `/resource/${id}`,
    // ... other routes
  }
};

<RoutingProvider routing={routingConfig}>
  {children}
</RoutingProvider>
```

### 3. Use in Components

```tsx
import { useRouting } from '@semiont/react-ui';

function NavigationMenu() {
  const { Link, routes } = useRouting();

  return (
    <nav>
      <Link href={routes.home}>Home</Link>
      <Link href={routes.discover}>Discover</Link>
    </nav>
  );
}
```

## Examples

### Next.js Integration

```tsx
// app/providers.tsx
import { RoutingProvider } from '@semiont/react-ui';
import NextLink from 'next/link';

const routingConfig = {
  Link: NextLink,
  routes: {
    home: '/',
    discover: '/know/discover',
    resource: (id: string) => `/know/resource/${id}`,
    moderate: '/moderate',
    administer: '/administer'
  }
};

export function Providers({ children }) {
  return (
    <RoutingProvider routing={routingConfig}>
      {children}
    </RoutingProvider>
  );
}
```

### React Router Integration

```tsx
import { RoutingProvider } from '@semiont/react-ui';
import { Link as RouterLink } from 'react-router-dom';

const routingConfig = {
  Link: RouterLink,
  routes: {
    home: '/',
    discover: '/discover',
    resource: (id: string) => `/resource/${id}`,
    moderate: '/moderate',
    administer: '/administer'
  }
};

function App() {
  return (
    <BrowserRouter>
      <RoutingProvider routing={routingConfig}>
        {children}
      </RoutingProvider>
    </BrowserRouter>
  );
}
```

### Wouter Integration

```tsx
import { RoutingProvider } from '@semiont/react-ui';
import { Link as WouterLink } from 'wouter';

const routingConfig = {
  Link: WouterLink,
  routes: {
    home: '/',
    discover: '/discover',
    resource: (id: string) => `/resource/${id}`,
    moderate: '/moderate',
    administer: '/administer'
  }
};

function App() {
  return (
    <RoutingProvider routing={routingConfig}>
      {children}
    </RoutingProvider>
  );
}
```

### Custom Link Component

If your routing library has different props, create an adapter:

```tsx
import { Link as YourRouterLink } from 'your-router';

function CustomLink({ href, children, ...props }) {
  // Adapt props to your router's API
  return (
    <YourRouterLink to={href} {...props}>
      {children}
    </YourRouterLink>
  );
}

const routingConfig = {
  Link: CustomLink,
  routes: { ... }
};
```

## Dynamic Routes

### Parameterized Routes

```typescript
routes: {
  // Simple parameter
  resource: (id: string) => `/resource/${id}`,

  // Multiple parameters
  annotation: (resourceId: string, annotationId: string) =>
    `/resource/${resourceId}/annotation/${annotationId}`,

  // Optional parameters
  search: (query?: string) => query ? `/search?q=${query}` : '/search',

  // Query parameters
  discover: (filters?: { category?: string; tags?: string[] }) => {
    const params = new URLSearchParams();
    if (filters?.category) params.set('category', filters.category);
    if (filters?.tags) params.set('tags', filters.tags.join(','));
    return `/discover?${params.toString()}`;
  }
}
```

### Usage

```tsx
function ResourceLink({ id }) {
  const { Link, routes } = useRouting();

  return (
    <Link href={routes.resource(id)}>
      View Resource
    </Link>
  );
}

function SearchLink({ query }) {
  const { Link, routes } = useRouting();

  return (
    <Link href={routes.search(query)}>
      Search for "{query}"
    </Link>
  );
}
```

## Navigation

### Programmatic Navigation

react-ui doesn't provide programmatic navigation. Use your router directly:

```tsx
// Next.js
import { useRouter } from 'next/navigation';

function MyComponent() {
  const router = useRouter();
  const { routes } = useRouting();

  const handleClick = () => {
    router.push(routes.resource('123'));
  };

  return <button onClick={handleClick}>Go to Resource</button>;
}
```

```tsx
// React Router
import { useNavigate } from 'react-router-dom';

function MyComponent() {
  const navigate = useNavigate();
  const { routes } = useRouting();

  const handleClick = () => {
    navigate(routes.resource('123'));
  };

  return <button onClick={handleClick}>Go to Resource</button>;
}
```

## Route Guards

Implement route guards in your app:

```tsx
// Next.js middleware.ts
import { NextResponse } from 'next/server';

export function middleware(request) {
  const isAuthenticated = request.cookies.get('session');

  if (!isAuthenticated && request.nextUrl.pathname.startsWith('/know')) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  return NextResponse.next();
}
```

```tsx
// React Router route configuration
import { Navigate } from 'react-router-dom';

function ProtectedRoute({ children }) {
  const { isAuthenticated } = useSessionContext();

  if (!isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return children;
}

// In routes
<Route path="/know/*" element={
  <ProtectedRoute>
    <KnowLayout />
  </ProtectedRoute>
} />
```

## Active Link Styling

Implement active link detection in your app:

```tsx
// Next.js
'use client';

import NextLink from 'next/link';
import { usePathname } from 'next/navigation';

function ActiveLink({ href, children, activeClassName, ...props }) {
  const pathname = usePathname();
  const isActive = pathname === href || pathname.startsWith(href + '/');

  return (
    <NextLink
      href={href}
      className={isActive ? activeClassName : ''}
      {...props}
    >
      {children}
    </NextLink>
  );
}

// Use in routing config
const routingConfig = {
  Link: ActiveLink,
  routes: { ... }
};
```

```tsx
// React Router (uses NavLink)
import { NavLink } from 'react-router-dom';

function StyledNavLink({ href, children, ...props }) {
  return (
    <NavLink
      to={href}
      className={({ isActive }) => isActive ? 'active' : ''}
      {...props}
    >
      {children}
    </NavLink>
  );
}

const routingConfig = {
  Link: StyledNavLink,
  routes: { ... }
};
```

## URL Generation

### Building URLs

```tsx
function ShareButton({ resourceId }) {
  const { routes } = useRouting();

  const shareUrl = `${window.location.origin}${routes.resource(resourceId)}`;

  return (
    <button onClick={() => navigator.clipboard.writeText(shareUrl)}>
      Share
    </button>
  );
}
```

### External Links

For external links, use regular `<a>` tags:

```tsx
function ExternalLink() {
  return (
    <a href="https://example.com" target="_blank" rel="noopener noreferrer">
      External Site
    </a>
  );
}
```

## Testing

Mock routing in tests:

```tsx
import { renderWithProviders } from '@semiont/react-ui/test-utils';

it('should render navigation links', () => {
  const mockRouting = {
    Link: ({ href, children }) => <a href={href}>{children}</a>,
    routes: {
      home: '/',
      discover: '/discover',
      resource: (id) => `/resource/${id}`
    }
  };

  renderWithProviders(<NavigationMenu />, {
    // Note: Need to add routing option to test-utils or wrap manually
  });

  expect(screen.getByText('Home')).toHaveAttribute('href', '/');
});
```

Or test with your actual router:

```tsx
import { MemoryRouter } from 'react-router-dom';

it('should navigate on click', async () => {
  const user = userEvent.setup();

  render(
    <MemoryRouter>
      <RoutingProvider routing={routingConfig}>
        <NavigationMenu />
      </RoutingProvider>
    </MemoryRouter>
  );

  await user.click(screen.getByText('Discover'));

  expect(window.location.pathname).toBe('/discover');
});
```

## Required Routes

Components in react-ui expect these routes to be defined:

**Core Routes:**
- `home` - Application home page
- `discover` - Resource discovery/browsing
- `resource(id)` - Individual resource view

**Optional Routes** (used by specific components):
- `moderate` - Moderation interface
- `administer` - Administration interface
- `settings` - User settings
- `about` - About page
- `privacy` - Privacy policy
- `terms` - Terms of service

**Check Component Usage:**

```bash
# Find which components use routing
grep -r "useRouting" packages/react-ui/src/components/
```

## Best Practices

### ✅ Do: Define all routes in one place

```tsx
const routingConfig = {
  Link: NextLink,
  routes: {
    // Public routes
    home: '/',
    about: '/about',

    // Knowledge routes
    discover: '/know/discover',
    resource: (id: string) => `/know/resource/${id}`,

    // Admin routes
    moderate: '/moderate',
    administer: '/administer',

    // User routes
    settings: '/settings',
    profile: (userId: string) => `/user/${userId}`,
  }
};
```

### ✅ Do: Use route functions for dynamic paths

```tsx
routes: {
  resource: (id: string) => `/resource/${id}`,
  // Not: resource: '/resource/:id'
}
```

### ✅ Do: Type-safe route parameters

```tsx
type ResourceId = string;

routes: {
  resource: (id: ResourceId) => `/resource/${id}`,
}
```

### ❌ Don't: Hardcode URLs in components

```tsx
// WRONG
<Link href="/know/resource/123">View Resource</Link>

// CORRECT
const { Link, routes } = useRouting();
<Link href={routes.resource('123')}>View Resource</Link>
```

### ❌ Don't: Include routing logic in react-ui

The library should never:
- Import specific routing libraries
- Implement navigation logic
- Handle URL parsing
- Manage browser history

All routing concerns belong in the app.

## See Also

- [PROVIDERS.md](PROVIDERS.md) - RoutingProvider details
- [COMPONENTS.md](COMPONENTS.md) - Components using routing
- [TESTING.md](TESTING.md) - Testing with routing
