# Frontend Development Guide

**Last Updated**: 2026-03-29

Complete guide to local development workflows, common tasks, debugging, and troubleshooting for the Semiont frontend.

## Table of Contents

- [Local Development with the `semiont` launcher](#local-development-with-the-semiont-launcher)
- [Manual Development Setup](#manual-development-setup)
- [Common Development Tasks](#common-development-tasks)
- [Environment Variables](#environment-variables)
- [Debugging Tips](#debugging-tips)
- [Common Troubleshooting](#common-troubleshooting)
- [Code Style Guidelines](#code-style-guidelines)
- [CSS and Styling Workflow](#css-and-styling-workflow)
- [Related Documentation](#related-documentation)

## Local Development with the `semiont` launcher

A running stack comes from the [`semiont` launcher](../../launcher/README.md) — a
host-installed binary that drives your container runtime. It is run **from a
knowledge-base repo**, not from this monorepo: the KB supplies the config, the
launcher pulls the service images.

### Essential commands

```bash
# From inside a KB clone
semiont start                     # The whole stack, plus the Browser on :3000
semiont status                    # Per-service container state + health probes
semiont logs                      # Follow all services, [svc]-prefixed
semiont stop                      # Tear the stack down

# One service at a time (backend | frontend | worker | smelter | weaver | database)
semiont start --service backend   # Start or restart just the backend
semiont stop --service frontend   # Close the Browser (it survives a bare `stop`)
```

`semiont start --config <name>` picks which of the KB's
`.semiont/semiontconfig/*.toml` to run (`--list-configs` lists them), and
`semiont start --dry-run` prints the exact runtime commands a real run would
execute.

### Two development modes

**Against a stack, iterating on this package** — start the stack, then run the
Vite dev server from `apps/browser` with `npm run dev` and point it at the
running backend on `:4000`. Fast HMR against real data; the stack's own frontend
container keeps serving the built SPA on `:3000` independently.

**Against locally built images** — when your change needs to be exercised as the
*shipped* container (or you changed a package the backend imports), rebuild with
[`scripts/ci/local-build.sh`](../../../scripts/ci/local-build.sh) and restart the
stack with `SEMIONT_VERSION=local semiont start`. Without that variable the
launcher pulls the published images and your changes are invisible.

### What the launcher gives you

- **One command, whole stack** — five Semiont services plus PostgreSQL, Neo4j,
  Qdrant, and Ollama, wired together.
- **No per-project install** — `@semiont/frontend` ships inside the frontend
  image; nothing to `npm install` per KB.
- **Runtime flexibility** — Apple Container, Docker, or Podman, auto-detected
  (`--runtime` forces one).
- **The Browser is machine-level** — any `start` ensures it, and it survives
  `stop`, because it views every KB rather than belonging to one.

### First-time setup

```bash
brew install the-ai-alliance/semiont/semiont
git clone <a-kb-repo> && cd <a-kb-repo>
semiont start
semiont useradd --email admin@example.com --admin   # prompts for the password
```

**Browser only** (point it at an existing KB):
```bash
semiont start --service frontend
# Serves the built SPA on :3000; connect it to any running backend
```

**Full-stack development** (feature work):
```bash
semiont start
# Five Semiont services + PostgreSQL, Neo4j, Qdrant, Ollama
```

**Backend integration testing**:
```bash
semiont start
# Then run the frontend from source against it:
cd apps/browser && npm run dev
# The stack's backend serves real data while Vite serves the SPA with HMR
```

**Fresh start** (reset data):
```bash
semiont stop
semiont clean     # Removes PostgreSQL, Qdrant, and Neo4j state
semiont start
```

`semiont clean` is the only thing that removes persistent stack state — `stop`
deliberately leaves it so the next `start` reuses it. It does not touch the event
log, which lives in the KB's git repo.

## Manual Development Setup

If you prefer manual setup or need to understand the internals:

### Development Modes (Manual)

**1. Standard Development** (`npm run dev`)
- Uses Vite dev server with hot reload
- Requires backend API running on port 4000

**2. Mock API Development** (`npm run dev:mock`) - Recommended for UI work
- Starts mock API server on port 3001
- No backend dependencies needed
- Perfect for rapid UI/UX iteration

**3. Fast Mode** (`npm run dev:fast`)
- Vite dev server with favicons and PDF.js pre-copied
- Requires backend API running separately

### Fast Iteration Features

- **Hot Module Replacement (HMR)** - Changes update instantly without losing state
- **Fast Refresh** - Error recovery without losing component state
- **Mock API Server** - Pre-configured endpoints for common operations
- **TypeScript Path Aliases** - Use `@/components` instead of relative imports

### Mock API Endpoints

The mock server (`npm run dev:mock`) provides:
- `/api/health` - Health check endpoint
- `/api/auth/session` - Mock authentication state
- `/api/admin/stats` - Dashboard statistics
- `/api/admin/users` - User management data

### Tips for Faster Development

1. **Component Playground** - Create `src/app/playground/page.tsx` for isolated component testing
2. **Disable Type Checking** (temporarily run tsc without --noEmit checks)
3. **Clear Cache** - Run `rm -rf node_modules/.vite` if experiencing stale module issues
4. **VS Code Integration** - Use Command Palette (`Cmd+Shift+P`) for quick file navigation

## Common Development Tasks

### Adding a New Page

**1. Create page component** in `src/app/[route]/page.tsx`:
```typescript
// src/app/dashboard/page.tsx
import { AsyncErrorBoundary } from "@/components/ErrorBoundary";
import { DashboardContent } from "@/components/DashboardContent";

export default function Dashboard() {
  return (
    <main className="container mx-auto px-4 py-8">
      <AsyncErrorBoundary>
        <DashboardContent />
      </AsyncErrorBoundary>
    </main>
  );
}
```

**2. Create component** in `src/components/`:
```typescript
// src/components/DashboardContent.tsx
import { useSemiont, useObservable } from "@semiont/react-ui";

export function DashboardContent() {
  const session = useObservable(useSemiont().activeSession$);
  // Verb-namespace queries emit CacheState values; `useObservable` bridges
  // them into React state (e.g. session?.client.browse.entityTypes()).
  const state = useObservable(session?.client.browse.entityTypes());

  if (!session) return <div>Please sign in to view dashboard</div>;
  if (!state || state.status === 'pending') return <div>Loading...</div>;
  if (state.status === 'failed') return <div>Failed to load</div>;

  return (
    <div>
      <h1>Dashboard</h1>
      {/* Your dashboard content */}
    </div>
  );
}
```

### Adding New API Integration

See [API Integration Guide](./API-INTEGRATION.md) for complete details.

**Quick example**: data access is exposed by `@semiont/sdk` as verb-namespace
methods on `SemiontClient` (e.g. `client.browse.*`) that return RxJS Observables
backed by EventBus-invalidated caches. Adding a new read means:

```typescript
// 1. The OpenAPI spec + generated types define the response shape
//    (specs/ → @semiont/core types). No hand-written response interfaces.

// 2. The SDK exposes it as a namespace method returning a CacheObservable
//    (added in @semiont/sdk, e.g. BrowseNamespace.dashboard(): CacheObservable<DashboardData>)

// 3. The component subscribes via useObservable — no React Query, no manual cache keys
import { useSemiont, useObservable } from '@semiont/react-ui';

function Dashboard() {
  const session = useObservable(useSemiont().activeSession$);
  const state = useObservable(session?.client.browse.dashboard()); // CacheState<DashboardData>
  // EventBus domain events invalidate and refresh the cache automatically.
}
```

See [API Integration Guide](./API-INTEGRATION.md) for the namespace + bus model.

### Adding New UI Components

**1. Create component** in `src/components/`:
```typescript
// src/components/MetricsCard.tsx
import { ReactNode } from 'react';

interface MetricsCardProps {
  title: string;
  value: string | number;
  icon?: ReactNode;
  trend?: 'up' | 'down' | 'neutral';
  className?: string;
}

export function MetricsCard({
  title,
  value,
  icon,
  trend = 'neutral',
  className = ''
}: MetricsCardProps) {
  const trendColors = {
    up: 'text-green-600',
    down: 'text-red-600',
    neutral: 'text-gray-600'
  };

  return (
    <div className={`bg-white rounded-lg shadow p-6 ${className}`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-600">{title}</p>
          <p className={`text-2xl font-semibold ${trendColors[trend]}`}>
            {value}
          </p>
        </div>
        {icon && (
          <div className="text-gray-400">
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}
```

**2. Use with error boundary**:
```typescript
<AsyncErrorBoundary>
  <MetricsCard
    title="Active Users"
    value={dashboardData?.metrics.activeUsers ?? 0}
    trend="up"
  />
</AsyncErrorBoundary>
```

### Adding Custom Hooks

**Create hook** in `src/hooks/`:
```typescript
// src/hooks/useLocalStorage.ts
import { useState, useEffect } from 'react';

export function useLocalStorage<T>(key: string, initialValue: T) {
  const [storedValue, setStoredValue] = useState<T>(initialValue);

  useEffect(() => {
    try {
      const item = window.localStorage.getItem(key);
      if (item) {
        setStoredValue(JSON.parse(item));
      }
    } catch (error) {
      console.warn(`Error reading localStorage key "${key}":`, error);
    }
  }, [key]);

  const setValue = (value: T | ((val: T) => T)) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      window.localStorage.setItem(key, JSON.stringify(valueToStore));
    } catch (error) {
      console.warn(`Error setting localStorage key "${key}":`, error);
    }
  };

  return [storedValue, setValue] as const;
}
```

### Adding Authentication Guards

**1. Create protected route wrapper**:
```typescript
// src/components/ProtectedRoute.tsx
import { useSemiont, useObservable } from "@semiont/react-ui";
import { useNavigate } from "react-router-dom";
import { useEffect } from "react";

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const browser = useSemiont();
  const session = useObservable(browser.activeSession$);
  const activating = useObservable(browser.sessionActivating$) ?? false;
  const navigate = useNavigate();

  useEffect(() => {
    if (!activating && !session) {
      navigate('/auth/signin');
    }
  }, [session, activating, navigate]);

  if (activating) {
    return <div className="flex justify-center p-8">Loading...</div>;
  }

  return session ? <>{children}</> : null;
}
```

**2. Use in protected pages**:
```typescript
// src/app/admin/page.tsx
import { ProtectedRoute } from "@/components/ProtectedRoute";

export default function AdminPage() {
  return (
    <ProtectedRoute>
      <AdminContent />
    </ProtectedRoute>
  );
}
```

## Environment Variables

Environment variables are configured automatically based on your environment configuration files in `/config/environments/`.

**1. Add to environment JSON** in `/config/environments/[env].json`:
```json
{
  "services": {
    "frontend": {
      "url": "https://staging.example.com",
      "port": 3000
    }
  }
}
```

**2. Deployment**: Environment variables are set automatically during deployment based on your configuration.

## Debugging Tips

### Authentication Issues
- Check browser dev tools Network tab
- Confirm requests carry an `Authorization: Bearer <jwt>` header — the access token lives in JS memory (held by the SDK session), not in a cookie
- Check /api/auth/me response for current session state
- Verify backend is running and accessible

### API Errors
- Review browser Network tab for failed requests
- Check API client error handling in console
- Verify backend is running and accessible
- Check CORS configuration

### Performance Issues
- Use `npm run analyze` to identify large bundles
- Review React DevTools Profiler
- Monitor Network waterfall in dev tools

### Build Errors
- Run `npm run typecheck` to identify TypeScript errors
- Verify all environment variables are set
- Check for unused imports or missing dependencies
- Clear Vite cache: `rm -rf node_modules/.vite`

### Runtime Errors
- Error boundaries capture detailed error information
- Check browser console for stack traces
- Review error boundary fallback UI
- Enable React strict mode for dev warnings

## Common Troubleshooting

### "API calls failing"
**Symptoms**: 404 or network errors when making API requests

**Solutions**:
- Check network tab for CORS issues
- Ensure backend is running and accessible
- Verify API endpoint path is correct
- Check authentication token is included

### "Authentication not working"
**Symptoms**: Unable to sign in or session not persisting

**Solutions**:
- Check backend logs for OAuth errors
- Confirm the SDK session captured an access token after login — it's held in JS memory and sent as `Authorization: Bearer`, not set as a cookie
- Check /api/auth/me returns correct user data
- Ensure OAuth callback URL in Google Cloud Console points to backend (/api/auth/oauth/google/callback)

### "Build failing"
**Symptoms**: `npm run build` fails with errors

**Solutions**:
- Run `npm run typecheck` to identify TypeScript errors
- Verify all environment variables are set
- Check for unused imports or missing dependencies
- Update dependencies: `npm update`
- Clear node_modules and reinstall: `rm -rf node_modules && npm install`

### "Performance issues"
**Symptoms**: Slow page loads, large bundle size

**Solutions**:
- Run `npm run perf` to identify bottlenecks
- Check bundle size with `npm run analyze`
- Implement code splitting with dynamic imports
- Optimize images (use appropriate sizes, lazy loading)

### "Hot reload not working"
**Symptoms**: Changes not reflecting in browser

**Solutions**:
- Check for syntax errors in console
- Restart dev server: `npm run dev`
- Clear Vite cache: `rm -rf node_modules/.vite`
- Check file watcher limits on Linux: `echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf`

## Code Style Guidelines

### Functional Programming

**Functional, side-effect free code is strongly preferred**:
- Use functional components with hooks
- Avoid class components and mutations
- Prefer pure functions
- Use immutable data structures
- Avoid side effects in business logic

### Component Patterns

- Use descriptive component and variable names
- Follow existing patterns in the codebase
- Prefer composition over inheritance
- Extract reusable logic into custom hooks
- Use error boundaries for error handling

### Documentation

- No unnecessary comments - code should be self-documenting
- Add JSDoc for complex functions
- Document non-obvious business logic
- Keep README and docs up to date

### TypeScript

- Enable strict mode
- Avoid `any` type
- Use type inference where possible
- Define interfaces for props and data structures
- Use const assertions for literal types

## CSS and Styling Workflow

The frontend uses a **hybrid CSS architecture** combining semantic CSS from @semiont/react-ui with Tailwind for app-specific styling.

### When to Use Which System

#### Use @semiont/react-ui Components (Semantic CSS)
When the component exists in @semiont/react-ui, use it directly:

```tsx
import { Button, Card, Toolbar } from '@semiont/react-ui';

// These come with semantic CSS classes pre-applied
<Button variant="primary">Click me</Button>
<Card>
  <Card.Header>Title</Card.Header>
  <Card.Content>Content</Card.Content>
</Card>
```

**Benefits:**
- Consistent styling across the application
- Framework-agnostic (no Tailwind dependency)
- Built-in accessibility features
- Managed dark mode support

#### Use Tailwind for App-Specific Components
For components unique to the frontend application:

```tsx
// App-specific layout component
<div className="flex items-center gap-4 p-6 bg-white dark:bg-gray-800">
  <span className="text-lg font-semibold">Custom content</span>
</div>
```

**Use Tailwind for:**
- Page layouts and containers
- Custom components not in @semiont/react-ui
- Spacing and positioning utilities
- One-off styling needs

### Combining Both Systems

When you need to add spacing or layout to @semiont/react-ui components:

```tsx
// Good - adds spacing without breaking component styles
<Button variant="primary" className="mt-4">
  Submit
</Button>

// Bad - overriding semantic classes
<Button variant="primary" className="bg-blue-500 hover:bg-blue-600">
  Submit
</Button>
```

### CSS Import Structure

The CSS is imported in `src/app/globals.css`:

```css
/* Tailwind */
@import "tailwindcss";

/* Import all @semiont/react-ui styles */
@import '@semiont/react-ui/styles';
```

### Dark Mode Coordination

- **@semiont/react-ui**: Uses `data-theme="dark"` attribute
- **Tailwind**: Uses `class="dark"` on HTML element
- Both are coordinated by the theme provider

### Style File Locations

- **App-specific styles:** `/src/lib/button-styles.ts`, `/src/lib/annotation-styles.ts`
- **Global styles:** `/src/app/globals.css`
- **Component library styles:** `@semiont/react-ui/styles` (imported automatically)

### Development Tips

1. **Check @semiont/react-ui first** - Before creating a custom component
2. **Use semantic classes** - Don't override @semiont/react-ui styles
3. **Test dark mode** - Ensure both systems work in dark mode
4. **Keep separation clear** - Components vs. layout utilities

For detailed styling guidelines, see the [Style Guide](./style-guide.md).

## Related Documentation

### Development Guides
- [Testing Guide](./TESTING.md) - Test structure, running tests, writing tests
- [API Integration](./API-INTEGRATION.md) - API client usage, async operations
- [Performance](./PERFORMANCE.md) - Bundle optimization, monitoring
- [Deployment](./DEPLOYMENT.md) - Publishing and deployment workflows

### Architecture
- [Frontend Architecture](./ARCHITECTURE.md) - High-level system design
- [Rendering Architecture](../../../packages/react-ui/docs/RENDERING-ARCHITECTURE.md) - Document rendering pipeline
- [Authentication](./AUTHENTICATION.md) - OAuth, JWT, session management

### Features
- [Annotations](./ANNOTATIONS.md) - W3C annotation system
- [Style Guide](./style-guide.md) - UI/UX patterns
- [Keyboard Navigation](./KEYBOARD-NAV.md) - Keyboard navigation implementation
- [Accessibility](./ACCESSIBILITY.md) - WCAG 2.1 AA implementation patterns

### System Documentation
- [System Documentation](../../../docs/system/README.md) - Overall platform
- [Backend README](../../backend/README.md) - Backend API
- [Launcher README](../../launcher/README.md) - `semiont` launcher usage

---

**Last Updated**: 2026-03-29
**For Questions**: See [System Documentation](../../../docs/) or file an issue
