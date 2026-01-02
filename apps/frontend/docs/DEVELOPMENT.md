# Frontend Development Guide

**Last Updated**: 2025-10-25

Complete guide to local development workflows, common tasks, debugging, and troubleshooting for the Semiont frontend.

## Table of Contents

- [Local Development with Semiont CLI](#local-development-with-semiont-cli)
- [Manual Development Setup](#manual-development-setup)
- [Common Development Tasks](#common-development-tasks)
- [Environment Variables](#environment-variables)
- [Debugging Tips](#debugging-tips)
- [Common Troubleshooting](#common-troubleshooting)
- [Code Style Guidelines](#code-style-guidelines)
- [Related Documentation](#related-documentation)

## Local Development with Semiont CLI

The recommended way to develop the frontend is using the Semiont CLI, which automatically manages dependencies and environment configuration.

###Essential Commands

```bash
# Set your environment once
export SEMIONT_ENV=local

# Full stack development
semiont start              # Start everything (database + backend + frontend)
semiont start --force      # Fresh start with clean database
semiont stop               # Stop all services
semiont check              # Check service health

# Frontend development
semiont start --service frontend  # Start frontend only
semiont stop --service frontend   # Stop frontend service

# Backend + database
semiont start --service backend   # Start backend only
semiont start --service database  # Start database only
semiont restart --service backend # Restart backend with fresh connection
```

### Development Modes

**1. Full Stack Development** (`semiont start`)
- Complete development environment in one command
- PostgreSQL container with schema applied automatically
- Backend API with database connection
- Frontend with real API integration
- **Perfect for full-stack feature development**

**2. Frontend-Only Development** (`semiont start --service frontend`)
- Start just the frontend service
- Configure mock API in environment settings if needed
- Fast iteration for UI/UX work
- **Perfect for component development and styling**

**3. Backend-Connected Development** (`semiont start --service backend,frontend`)
- Start backend and frontend together
- Real API integration
- **Perfect for testing API integration**

**4. Manual Development** (`npm run dev` - traditional approach)
- Requires manual backend/database setup
- Full control over environment configuration
- **For developers who prefer manual environment management**

### Why Use Semiont CLI for Frontend?

- **Smart Dependencies**: Frontend auto-starts backend when needed
- **Consistent Environment**: Everyone gets identical setup
- **Zero Configuration**: No environment files, API URLs, or manual setup
- **Easy Reset**: Fresh database with sample data via `--reset`
- **Focused Development**: Mock mode for UI work, real API mode for integration
- **Container Runtime Flexibility**: Works with Docker or Podman (auto-detected)

### Development Workflow with Semiont CLI

**First time setup** (run once):
```bash
cd /your/project/root
npm install  # Installs dependencies for all apps
semiont init --name "my-project"  # Initialize configuration
export SEMIONT_ENV=local  # Set default environment
```

**Frontend-focused development** (UI/UX work):
```bash
semiont start --service frontend
# Only frontend running (configure mock API in environment if needed)
# Perfect for component development, styling, layout work
```

**Full-stack development** (feature work):
```bash
semiont start
# Complete environment: database + backend + frontend
# Perfect for implementing features that need real API integration
```

**Backend integration testing**:
```bash
semiont start --service backend,frontend
# Frontend + real backend + database
# Perfect for testing API integration without manual backend setup
```

**Fresh start** (reset data):
```bash
semiont restart --force
# Clean restart with fresh connections
# Perfect when you need to reset state
```

## Manual Development Setup

If you prefer manual setup or need to understand the internals:

### Development Modes (Manual)

**1. Standard Development** (`npm run dev`)
- Uses Next.js dev server with hot reload
- Requires backend API running on port 3001

**2. Mock API Development** (`npm run dev:mock`) - Recommended for UI work
- Starts mock API server on port 3001
- No backend dependencies needed
- Perfect for rapid UI/UX iteration

**3. Turbo Mode** (`npm run dev:fast`) - Experimental
- Uses Next.js Turbopack for faster builds
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
2. **Disable Type Checking** (temporary) - Add `NEXT_DISABLE_TYPE_CHECK=true` to `.env.local`
3. **Clear Cache** - Run `rm -rf .next` if experiencing slow builds
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
"use client";

import { api } from "@/lib/api-client";
import { useAuth } from "@/hooks/useAuth";

export function DashboardContent() {
  const { isFullyAuthenticated } = useAuth();
  const { data, isLoading, error } = api.dashboard.getData.useQuery();

  if (!isFullyAuthenticated) {
    return <div>Please sign in to view dashboard</div>;
  }

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

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

**Quick example**:
```typescript
// 1. Define types in src/lib/api-client.ts
interface DashboardDataResponse {
  metrics: {
    activeUsers: number;
    totalPosts: number;
    systemStatus: string;
  };
  recentActivity: Activity[];
}

// 2. Add API service method
export const apiService = {
  dashboard: {
    getData: (): Promise<DashboardDataResponse> =>
      apiClient.get('/api/dashboard/data'),
  },
};

// 3. Add React Query hook
export const api = {
  dashboard: {
    getData: {
      useQuery: () => {
        return useQuery({
          queryKey: ['dashboard.data'],
          queryFn: () => apiService.dashboard.getData(),
          enabled: !!useAuth().isFullyAuthenticated,
        });
      }
    }
  }
};
```

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
"use client";

import { useAuth } from "@/hooks/useAuth";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

interface ProtectedRouteProps {
  children: React.ReactNode;
  requireFullAuth?: boolean;
}

export function ProtectedRoute({
  children,
  requireFullAuth = false
}: ProtectedRouteProps) {
  const { isAuthenticated, isFullyAuthenticated, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading) {
      const hasRequiredAuth = requireFullAuth ? isFullyAuthenticated : isAuthenticated;

      if (!hasRequiredAuth) {
        router.push('/auth/signin');
      }
    }
  }, [isAuthenticated, isFullyAuthenticated, isLoading, requireFullAuth, router]);

  if (isLoading) {
    return <div className="flex justify-center p-8">Loading...</div>;
  }

  const hasRequiredAuth = requireFullAuth ? isFullyAuthenticated : isAuthenticated;

  return hasRequiredAuth ? <>{children}</> : null;
}
```

**2. Use in protected pages**:
```typescript
// src/app/admin/page.tsx
import { ProtectedRoute } from "@/components/ProtectedRoute";

export default function AdminPage() {
  return (
    <ProtectedRoute requireFullAuth={true}>
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

**2. Access in code** via validation schema in `src/lib/env.ts`:
```typescript
const envSchema = z.object({
  SERVER_API_URL: z.string().url(),
  NEXTAUTH_URL: z.string().url(),
});
```

**3. Deployment**: Environment variables are set automatically during deployment based on your configuration.

## Debugging Tips

### Authentication Issues
- Check browser dev tools Network tab
- Review NextAuth debug logs
- Verify JWT token in Authorization header
- Check session cookie in Application tab

### API Errors
- Review browser Network tab for failed requests
- Check API client error handling in console
- Verify backend is running and accessible
- Check CORS configuration

### Performance Issues
- Use `npm run analyze` to identify large bundles
- Check Lighthouse CI reports
- Review React DevTools Profiler
- Monitor Network waterfall in dev tools

### Build Errors
- Run `npm run type-check` to identify TypeScript errors
- Verify all environment variables are set
- Check for unused imports or missing dependencies
- Clear Next.js cache: `rm -rf .next`

### Runtime Errors
- Error boundaries capture detailed error information
- Check browser console for stack traces
- Review error boundary fallback UI
- Enable React strict mode for dev warnings

## Common Troubleshooting

### "API calls failing"
**Symptoms**: 404 or network errors when making API requests

**Solutions**:
- Verify `SERVER_API_URL` is set correctly
- Check network tab for CORS issues
- Ensure backend is running and accessible
- Verify API endpoint path is correct
- Check authentication token is included

### "Authentication not working"
**Symptoms**: Unable to sign in or session not persisting

**Solutions**:
- Check Google OAuth configuration in Google Cloud Console
- Verify `NEXTAUTH_URL` matches your domain
- Check browser cookies and local storage
- Ensure callback URL is whitelisted in OAuth settings
- Review NextAuth.js debug logs

### "Build failing"
**Symptoms**: `npm run build` fails with errors

**Solutions**:
- Run `npm run type-check` to identify TypeScript errors
- Verify all environment variables are set
- Check for unused imports or missing dependencies
- Update dependencies: `npm update`
- Clear node_modules and reinstall: `rm -rf node_modules && npm install`

### "Performance issues"
**Symptoms**: Slow page loads, large bundle size

**Solutions**:
- Run `npm run perf` to identify bottlenecks
- Check bundle size with `npm run analyze`
- Review Lighthouse CI reports for optimization suggestions
- Implement code splitting with dynamic imports
- Optimize images with Next.js Image component

### "Hot reload not working"
**Symptoms**: Changes not reflecting in browser

**Solutions**:
- Check for syntax errors in console
- Restart dev server: `npm run dev`
- Clear Next.js cache: `rm -rf .next`
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

## Related Documentation

### Development Guides
- [Testing Guide](./TESTING.md) - Test structure, running tests, writing tests
- [API Integration](./API-INTEGRATION.md) - API client usage, async operations
- [Performance](./PERFORMANCE.md) - Bundle optimization, monitoring
- [Deployment](./DEPLOYMENT.md) - Publishing and deployment workflows

### Architecture
- [Frontend Architecture](./ARCHITECTURE.md) - High-level system design
- [Rendering Architecture](./RENDERING-ARCHITECTURE.md) - Document rendering pipeline
- [Authentication](./AUTHENTICATION.md) - OAuth, JWT, session management

### Features
- [Annotations](./ANNOTATIONS.md) - W3C annotation system
- [Style Guide](./style-guide.md) - UI/UX patterns
- [Keyboard Navigation](./KEYBOARD-NAV.md) - WCAG accessibility

### System Documentation
- [System Architecture](../../../docs/ARCHITECTURE.md) - Overall platform
- [Backend README](../../backend/README.md) - Backend API
- [CLI README](../../cli/README.md) - CLI usage

---

**Last Updated**: 2025-10-25
**For Questions**: See [System Documentation](../../../docs/) or file an issue
