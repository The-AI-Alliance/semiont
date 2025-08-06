# Semiont Frontend

A modern, type-safe React frontend built with Next.js 14, featuring comprehensive authentication, performance optimization, and robust error handling.

## Quick Start

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env.local
# Edit .env.local with your configuration

# Start development server
npm run dev

# Start with mock API (no backend required)
npm run dev:mock

# Build for production
npm run build
npm start

# Performance analysis
npm run perf
```

## Local Development

### Development Modes

1. **Standard Development** (`npm run dev`)
   - Uses Next.js dev server with hot reload
   - Requires backend API running on port 4000

2. **Mock API Development** (`npm run dev:mock`) - **Recommended for UI work**
   - Starts mock API server on port 4000
   - No backend dependencies needed
   - Perfect for rapid UI/UX iteration

3. **Turbo Mode** (`npm run dev:fast`) - **Experimental**
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

## Technology Stack

- **Framework**: [Next.js 14](https://nextjs.org/) with App Router
- **UI**: React 18 with TypeScript
- **Styling**: [Tailwind CSS](https://tailwindcss.com/) for utility-first styling
- **Authentication**: [NextAuth.js](https://next-auth.js.org/) with Google OAuth
- **State Management**: [TanStack Query](https://tanstack.com/query) (React Query) for server state
- **API Client**: Type-safe API client with automatic error handling
- **Validation**: [Zod](https://zod.dev/) for runtime type validation
- **Performance**: Bundle analysis, Lighthouse CI, and performance monitoring

## Project Structure

```
src/
├── app/                    # Next.js 14 App Router
│   ├── api/               # API routes (NextAuth.js)
│   │   └── auth/          # Authentication endpoints
│   ├── auth/              # Authentication pages
│   │   ├── error/         # OAuth error handling
│   │   └── signin/        # Custom sign-in page
│   ├── globals.css        # Global styles and Tailwind imports
│   ├── layout.tsx         # Root layout with providers
│   ├── page.tsx           # Home page with error boundaries
│   ├── error.tsx          # Global error boundary
│   └── providers.tsx      # Client-side providers (Auth, Query)
├── components/             # Reusable UI components
│   ├── ErrorBoundary.tsx  # Async error boundary component
│   ├── FeatureCards.tsx   # Feature showcase component
│   ├── GreetingSection.tsx # Interactive greeting with API
│   ├── Header.tsx         # Main navigation header
│   ├── StatusDisplay.tsx  # System status component
│   └── UserMenu.tsx       # User authentication menu
├── hooks/                  # Custom React hooks
│   ├── useAPI.ts          # Generic API interaction hook
│   ├── useAuth.ts         # Authentication state and utilities
│   ├── useSecureAPI.ts    # Authenticated API calls hook
│   └── useUI.ts           # UI state management hook
├── lib/                   # Core utilities and configuration
│   ├── api-client.ts      # Type-safe API client with React Query
│   ├── env.ts             # Environment variable validation
│   └── validation.ts      # Zod schemas and validation utilities
└── types/                 # TypeScript type definitions
    └── next-auth.d.ts     # NextAuth.js type extensions

Performance & Analysis:
├── scripts/               # Performance monitoring scripts
│   ├── analyze-bundle.js  # Bundle size analysis
│   └── performance-monitor.js # Performance metrics collection
├── performance-reports/   # Generated performance reports
├── lighthouserc.json     # Lighthouse CI configuration
└── performance.config.js # Performance monitoring config
```

## Core Design Decisions

### 1. Type Safety Throughout

Every API interaction is fully typed from backend to frontend:

```typescript
// API client with full type safety
const { data, error, isLoading } = api.hello.getStatus.useQuery();
// data is typed as StatusResponse
// error is typed as APIError
```

### 2. Comprehensive Error Boundaries

Each major component is wrapped in error boundaries to prevent cascading failures:

```typescript
// Strategic error boundary placement
<AsyncErrorBoundary>
  <GreetingSection />
</AsyncErrorBoundary>
```

### 3. Authentication-First Architecture

Authentication state is managed centrally with validation:

```typescript
// Multi-layer authentication validation
const {
  isAuthenticated,      // NextAuth session exists
  hasValidBackendToken, // Backend JWT is valid
  isFullyAuthenticated, // Both conditions met
} = useAuth();
```

### 4. Performance Optimization Built-in

Comprehensive performance monitoring and optimization:

```typescript
// Automatic bundle analysis and Lighthouse CI
npm run perf    // Full performance analysis
npm run analyze // Bundle size analysis only
```

### 5. Environment Variable Validation

Frontend environment variables are validated at build time:

```typescript
// src/lib/env.ts
const envSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url(),
  NEXTAUTH_URL: z.string().url(),
  // Fail fast if misconfigured
});
```

## Common Development Tasks

### Adding a New Page

1. **Create page component** in `src/app/[route]/page.tsx`:
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

2. **Create component** in `src/components/`:
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

1. **Define types** in `src/lib/api-client.ts`:
```typescript
interface DashboardDataResponse {
  metrics: {
    activeUsers: number;
    totalPosts: number;
    systemStatus: string;
  };
  recentActivity: Activity[];
}
```

2. **Add API service method**:
```typescript
export const apiService = {
  dashboard: {
    getData: (): Promise<DashboardDataResponse> =>
      apiClient.get('/api/dashboard/data'),
  },
};
```

3. **Add React Query hook**:
```typescript
export const api = {
  dashboard: {
    getData: {
      useQuery: () => {
        return useQuery({
          queryKey: ['dashboard.data'],
          queryFn: () => apiService.dashboard.getData(),
          // Require authentication
          enabled: !!useAuth().isFullyAuthenticated,
        });
      }
    }
  }
};
```

### Adding New UI Components  

1. **Create component** in `src/components/`:
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

2. **Use with error boundary**:
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

1. **Create hook** in `src/hooks/`:
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

1. **Create protected route wrapper**:
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

2. **Use in protected pages**:
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

### Environment Variables

Add new environment variables in three places:

1. **Validation schema** in `src/lib/env.ts`:
```typescript
const envSchema = z.object({
  NEXT_PUBLIC_NEW_SERVICE_URL: z.string().url(),
  NEW_SECRET_KEY: z.string().min(1),
});
```

2. **Environment file** `.env.local`:
```
NEXT_PUBLIC_NEW_SERVICE_URL=https://api.newservice.com
NEW_SECRET_KEY=your_secret_key_here
```

3. **Docker/deployment configuration** (if needed for build-time variables)

## Performance Optimization

### Bundle Analysis

```bash
# Analyze bundle size and composition
npm run analyze-bundle

# Generate detailed webpack bundle report
npm run bundle-analyzer

# Full performance check (bundle + Lighthouse)
npm run perf
```

### Lighthouse CI Integration

```bash
# Run Lighthouse CI tests
npm run lighthouse

# Run continuous performance monitoring
npm run perf-monitor
```

### Performance Best Practices

1. **Code Splitting**: Automatic with Next.js App Router
2. **Image Optimization**: Use Next.js `Image` component
3. **API Caching**: Configured with TanStack Query
4. **Error Boundaries**: Prevent cascading failures
5. **Lazy Loading**: Components loaded on demand

## Testing

The frontend uses **Vitest** with React Testing Library for testing React components and custom hooks, along with **MSW v2** (Mock Service Worker) for API mocking.

### Running Tests

#### Using Semiont CLI (Recommended)

```bash
# Run all frontend tests with coverage (from project root)
./scripts/semiont test frontend

# Run specific test types for frontend
./scripts/semiont test frontend unit         # Unit tests only (~1007 tests)
./scripts/semiont test frontend integration  # Integration tests only (~5 tests)
./scripts/semiont test frontend api         # API route tests only (~77 tests)
./scripts/semiont test frontend security    # Security tests only (~5 tests)

# Watch mode for development
./scripts/semiont test frontend unit --watch

# Skip coverage reporting for faster runs
./scripts/semiont test frontend --no-coverage
```

#### Direct npm Scripts

```bash
# Run all tests
npm test

# Run specific test types
npm run test:unit          # Unit tests (excludes integration tests)
npm run test:integration   # Integration tests only (signup flows, etc.)
npm run test:api           # API route tests only
npm run test:security      # Security-focused tests only

# Run tests with coverage report
npm run test:coverage

# Run tests in watch mode (development)
npm run test:watch

# Type checking
npm run type-check

# Build (includes type checking)
npm run build

# Performance testing
npm run perf
```

#### Performance Benefits

Specific test type filtering provides significant performance improvements:

- **Unit tests**: ~1007 tests (filters out integration tests)
- **Integration tests**: ~5 tests (massive speedup for testing user flows)
- **API tests**: ~77 tests (focuses on Next.js API routes)
- **Security tests**: ~5 tests (authentication, GDPR compliance, validation)

### Test Stack

- **Test Runner**: [Vitest](https://vitest.dev/) - Fast, ESM-native test runner built on Vite
- **Testing Library**: [React Testing Library](https://testing-library.com/react) for component testing
- **API Mocking**: [MSW v2](https://mswjs.io/) for intercepting and mocking API requests
- **Assertions**: Vitest's built-in assertions + [@testing-library/jest-dom](https://github.com/testing-library/jest-dom)

### Current Test Coverage

- **100% test success rate** with 244 tests passing
- Comprehensive coverage of cookie consent system, authentication, and UI components
- Key areas with excellent coverage:
  - Cookie management (`cookies.ts`) - 87.57% coverage
  - Cookie UI components - 100% coverage
  - Authentication components - 100% coverage
  - Error boundaries - 100% coverage

### Testing Philosophy

The frontend combines **type safety, unit testing, and performance monitoring** for comprehensive quality assurance:

1. **Type Safety First** - TypeScript provides compile-time validation across all components
2. **Unit & Integration Tests** - Critical business logic and UI components are thoroughly tested
3. **API Mocking** - MSW v2 provides realistic API mocking without changing application code
4. **Performance as Testing** - Lighthouse CI and bundle analysis catch regressions
5. **Error Boundaries** - Runtime error handling captures edge cases in production

### Test Structure

Tests are organized by type for efficient targeted testing:

#### 🧩 Unit Tests
```
src/
├── components/__tests__/          # Component unit tests (UI logic)
├── lib/__tests__/                # Library function tests (utilities)  
├── hooks/__tests__/              # Custom hook tests (state management)
└── app/__tests__/                # Page component tests (rendering)
```

#### 🔗 Integration Tests  
```
src/
└── app/auth/__tests__/
    └── signup-flow.integration.test.tsx  # Multi-component user flows
```

#### 🌐 API Tests
```
src/
└── app/api/
    ├── auth/[...nextauth]/__tests__/     # NextAuth.js route tests
    ├── cookies/consent/__tests__/        # Cookie consent API tests
    └── cookies/export/__tests__/         # Data export API tests
```

#### 🔒 Security Tests
Security-focused tests are identified by naming pattern (`*security*`) and test:
- Authentication flows and JWT validation
- GDPR compliance features (cookie consent, data export)
- Admin access controls and authorization
- Input validation and sanitization

#### Mock Infrastructure
```
src/mocks/                        # MSW mock handlers
├── browser.ts                    # Browser-side MSW setup
├── server.ts                     # Node-side MSW setup  
└── handlers.ts                   # API mock handlers
```

### Writing Tests

#### Component Test Example

```typescript
// src/components/__tests__/CookieBanner.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CookieBanner } from '../CookieBanner';

describe('CookieBanner', () => {
  it('should show banner when consent is not given', async () => {
    render(<CookieBanner />);
    
    expect(screen.getByText(/We use cookies/)).toBeInTheDocument();
  });

  it('should handle accept all cookies', async () => {
    render(<CookieBanner />);
    
    const acceptButton = screen.getByText('Accept All');
    fireEvent.click(acceptButton);
    
    // Banner should be hidden after accepting
    expect(screen.queryByText('Accept All')).not.toBeInTheDocument();
  });
});
```

#### API Mocking with MSW

```typescript
// src/mocks/handlers.ts
import { http, HttpResponse } from 'msw';

export const handlers = [
  http.get('/api/hello/greeting', () => {
    return HttpResponse.json({
      message: 'Hello from MSW!',
      timestamp: new Date().toISOString(),
    });
  }),
  
  http.post('/api/auth/login', async ({ request }) => {
    const { email } = await request.json();
    return HttpResponse.json({
      user: { email, id: '123' },
      token: 'mock-jwt-token',
    });
  }),
];
```

#### Testing with Vitest

Vitest provides a Jest-compatible API with better ESM support:

```typescript
// Mocking modules
vi.mock('@/lib/cookies', () => ({
  getCookieConsent: vi.fn(),
  setCookieConsent: vi.fn(),
}));

// Spying on functions
const mockFn = vi.fn();
vi.spyOn(window, 'fetch').mockResolvedValue(response);

// Assertions
expect(element).toBeInTheDocument();
expect(mockFn).toHaveBeenCalledWith(expectedArgs);
```

### ESM Configuration

The project uses native ES modules throughout:

```javascript
// vitest.config.js
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

### TypeScript Support for Tests

Tests benefit from the same strict TypeScript checking as the main codebase:

```bash
# Type check main code
npm run type-check

# Type check test files
npm run type-check:test

# Type check everything
npm run type-check:all
```

A separate `tsconfig.test.json` extends the main TypeScript config to include test files, ensuring type safety across all code.

**Note**: Test files were previously excluded from TypeScript compilation but now have full type checking enabled for better test quality and maintainability.

### Testing Strategy

**Performance-Based Quality Assurance**:
```bash
# Comprehensive performance testing
npm run perf                    # Full performance analysis
npm run lighthouse             # User experience validation
npm run analyze-bundle         # Bundle size regression detection
```

**Type Safety as Test Coverage**:
```typescript
// All components are fully typed
export function GreetingSection(): JSX.Element {
  const { data, error, isLoading } = api.hello.greeting.useQuery();
  // TypeScript ensures data structure matches API contract
}
```

**Error Boundary Testing**:
```typescript
// Runtime error capture and graceful degradation
<AsyncErrorBoundary>
  <ComponentThatMightFail />
</AsyncErrorBoundary>
```

### Quality Assurance Approach

Instead of extensive unit testing, the frontend relies on:

1. **Strict TypeScript** - Catches errors at compile time
2. **Performance Monitoring** - Real user experience validation
3. **Error Boundaries** - Production error capture and recovery
4. **Bundle Analysis** - Prevent performance regressions
5. **API Contract Testing** - Backend tests validate shared interfaces

### Manual Testing

```bash
# Test authentication flow
curl http://localhost:3000/api/auth/session

# Test API integration
curl http://localhost:3000/api/auth/csrf

# Performance testing
npm run perf
```

### Future Testing Enhancements

Planned improvements for higher test coverage:

1. **Component Unit Tests** - Critical UI component testing
2. **Hook Testing** - Custom React hook validation
3. **Integration Tests** - Full user authentication flows
4. **Visual Regression Tests** - UI consistency validation
5. **E2E Testing** - Complete user journey validation

## Security Features

- **Authentication validation** - Multi-layer auth checking (NextAuth + JWT)
- **API error handling** - Structured error responses with proper HTTP status codes
- **Environment validation** - Build-time validation of configuration
- **CORS protection** - Configured for specific backend domains
- **XSS prevention** - Next.js built-in protections + input sanitization
- **Content Security Policy** - Configured headers for enhanced security

## Architecture Benefits

1. **Type Safety**: Full-stack type safety from API to UI
2. **Performance**: Built-in monitoring, analysis, and optimization
3. **Reliability**: Comprehensive error boundaries and graceful degradation
4. **Authentication**: Robust, multi-layer authentication system
5. **Developer Experience**: Hot reloading, auto-completion, and inline documentation
6. **Maintainability**: Clear patterns and consistent code organization
7. **Scalability**: Modular architecture with reusable components and hooks

## Debugging Tips

- **Authentication issues**: Check browser dev tools Network tab and NextAuth debug logs
- **API errors**: Review browser Network tab and check API client error handling
- **Performance issues**: Use `npm run analyze` to identify large bundles
- **Build errors**: Check TypeScript errors and environment variable validation
- **Runtime errors**: Error boundaries capture detailed error information

## Common Troubleshooting

### "API calls failing"
- Verify `NEXT_PUBLIC_API_URL` is set correctly
- Check network tab for CORS issues
- Ensure backend is running and accessible

### "Authentication not working"
- Check Google OAuth configuration
- Verify `NEXTAUTH_URL` matches your domain
- Check browser cookies and local storage

### "Build failing"
- Run `npm run type-check` to identify TypeScript errors
- Verify all environment variables are set
- Check for unused imports or missing dependencies

### "Performance issues"
- Run `npm run perf` to identify bottlenecks
- Check bundle size with `npm run analyze`
- Review Lighthouse CI reports for optimization suggestions

## Further Reading

- [Next.js 14 Documentation](https://nextjs.org/docs)
- [NextAuth.js Documentation](https://next-auth.js.org/)
- [TanStack Query Documentation](https://tanstack.com/query)
- [Tailwind CSS Documentation](https://tailwindcss.com/docs)
- [React Query Best Practices](https://tkdodo.eu/blog/practical-react-query)