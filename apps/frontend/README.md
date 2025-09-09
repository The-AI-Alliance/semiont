# Semiont Frontend

A modern, type-safe React frontend built with Next.js 14, featuring comprehensive authentication, document management with advanced selection and reference capabilities, markdown rendering with wiki-style links, and robust error handling.

## Quick Start

### 🚀 Instant Setup with Semiont CLI (Recommended)

```bash
# Set your development environment
export SEMIONT_ENV=local

# From project root - starts everything automatically!
semiont start

# This will:
# ✅ Start PostgreSQL container with correct schema
# ✅ Start backend with proper environment
# ✅ Start frontend connected to backend
# 🎉 Ready to develop in ~30 seconds!
```

**That's it!** Your complete development environment is running:
- **Frontend**: http://localhost:3000  
- **Backend**: http://localhost:3001
- **Database**: PostgreSQL in Docker container

### 🛠 Manual Setup (Alternative)

```bash
# Install dependencies
npm install

# Start development server (with hot reload)
npm run dev

# Start with mock API (no backend required)
npm run dev:mock

# Build for production (handled automatically by semiont publish)
npm run build
npm start

# Performance analysis
npm run perf
```

**Note on Building**: For local development, use `npm run dev` for hot reload. For production deployment, `semiont publish` handles building TypeScript locally before creating Docker images. See [DEPLOYMENT.md](../../docs/DEPLOYMENT.md) for details.

## 💻 Local Development with Semiont CLI

### Essential Commands

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

1. **🚀 Full Stack Development** (`semiont start`)
   - Complete development environment in one command
   - PostgreSQL container with schema applied automatically
   - Backend API with database connection
   - Frontend with real API integration
   - **Perfect for full-stack feature development**

2. **🎨 Frontend-Only Development** (`semiont start --service frontend`)
   - Start just the frontend service
   - Configure mock API in environment settings if needed
   - Fast iteration for UI/UX work
   - **Perfect for component development and styling**

3. **⚡ Backend-Connected Development** (`semiont start --service backend,frontend`)
   - Start backend and frontend together
   - Real API integration
   - **Perfect for testing API integration**

4. **🔧 Manual Development** (`npm run dev` - traditional approach)
   - Requires manual backend/database setup
   - Full control over environment configuration
   - **For developers who prefer manual environment management**

### Why Use Semiont CLI for Frontend?

- **🔄 Smart Dependencies**: Frontend auto-starts backend when needed
- **📦 Consistent Environment**: Everyone gets identical setup  
- **⚡ Zero Configuration**: No environment files, API URLs, or manual setup
- **🧹 Easy Reset**: Fresh database with sample data via `--reset`
- **🎯 Focused Development**: Mock mode for UI work, real API mode for integration
- **🐳 Container Runtime Flexibility**: Works with Docker or Podman (auto-detected)

### Development Workflow with Semiont CLI

1. **First time setup** (run once):
```bash
cd /your/project/root
npm install  # Installs dependencies for all apps
semiont init --name "my-project"  # Initialize configuration
export SEMIONT_ENV=local  # Set default environment
```

2. **Frontend-focused development** (UI/UX work):
```bash
semiont start --service frontend
# Only frontend running (configure mock API in environment if needed)
# Perfect for component development, styling, layout work
```

3. **Full-stack development** (feature work):
```bash  
semiont start
# Complete environment: database + backend + frontend
# Perfect for implementing features that need real API integration
```

4. **Backend integration testing**:
```bash
semiont start --service backend,frontend
# Frontend + real backend + database
# Perfect for testing API integration without manual backend setup
```

5. **Fresh start** (reset data):
```bash
semiont restart --force
# Clean restart with fresh connections
# Perfect when you need to reset state
```

### Traditional Manual Setup (Alternative)

If you prefer manual setup or need to understand the internals:

#### Development Modes (Manual)

1. **Standard Development** (`npm run dev`)
   - Uses Next.js dev server with hot reload
   - Requires backend API running on port 3001

2. **Mock API Development** (`npm run dev:mock`) - **Recommended for UI work**
   - Starts mock API server on port 3001
   - No backend dependencies needed
   - Perfect for rapid UI/UX iteration

3. **Turbo Mode** (`npm run dev:fast`) - **Experimental**
   - Uses Next.js Turbopack for faster builds
   - Requires backend API running separately

#### Fast Iteration Features

- **Hot Module Replacement (HMR)** - Changes update instantly without losing state
- **Fast Refresh** - Error recovery without losing component state
- **Mock API Server** - Pre-configured endpoints for common operations
- **TypeScript Path Aliases** - Use `@/components` instead of relative imports

#### Mock API Endpoints

The mock server (`npm run dev:mock`) provides:
- `/api/health` - Health check endpoint
- `/api/auth/session` - Mock authentication state
- `/api/admin/stats` - Dashboard statistics
- `/api/admin/users` - User management data

#### Tips for Faster Development

1. **Component Playground** - Create `src/app/playground/page.tsx` for isolated component testing
2. **Disable Type Checking** (temporary) - Add `NEXT_DISABLE_TYPE_CHECK=true` to `.env.local`
3. **Clear Cache** - Run `rm -rf .next` if experiencing slow builds
4. **VS Code Integration** - Use Command Palette (`Cmd+Shift+P`) for quick file navigation

## Deployment

### Publishing and Updating

The frontend is deployed using the `semiont publish` and `semiont update` commands:

```bash
# Development/staging deployment (uses 'latest' tag)
semiont publish --service frontend --environment dev --semiont-repo /path/to/semiont
semiont update --service frontend --environment dev --wait

# Production deployment (uses git hash for immutability)
semiont publish --service frontend --environment production --semiont-repo /path/to/semiont
semiont update --service frontend --environment production --wait
```

**Note**: The `--semiont-repo` parameter points to where the Semiont platform code is located (containing the Dockerfiles and application source). This is typically a separate repository from your project configuration.

### How It Works

1. **Build Process**: `semiont publish` builds TypeScript/Next.js locally with proper environment variables before creating Docker images
2. **Image Tagging**: 
   - Development environments use `latest` tag (mutable)
   - Production environments use git commit hash (immutable)
   - Controlled by `deployment.imageTagStrategy` in environment config
3. **Deployment**: `semiont update` forces ECS to redeploy with the current task definition

### Environment Configuration

Configure deployment behavior in `/config/environments/[env].json`:

```json
{
  "deployment": {
    "imageTagStrategy": "mutable"    // or "immutable" for production
  }
}
```

See [DEPLOYMENT.md](../../docs/DEPLOYMENT.md) for detailed deployment workflows.

## Technology Stack

- **Framework**: [Next.js 14](https://nextjs.org/) with App Router
- **UI**: React 18 with TypeScript
- **Styling**: [Tailwind CSS](https://tailwindcss.com/) for utility-first styling
- **Authentication**: [NextAuth.js](https://next-auth.js.org/) with Google OAuth
- **State Management**: [TanStack Query](https://tanstack.com/query) (React Query) for server state
- **API Client**: Type-safe API client with automatic error handling
- **Validation**: [Zod](https://zod.dev/) for runtime type validation
- **Markdown**: [react-markdown](https://github.com/remarkjs/react-markdown) with remark/rehype plugins
- **Performance**: Bundle analysis, Lighthouse CI, and performance monitoring

## Project Structure

```
src/
├── app/                    # Next.js 14 App Router
│   ├── auth/              # Authentication routes
│   │   ├── [...nextauth]/ # NextAuth.js OAuth handlers
│   │   ├── mcp-setup/     # MCP client authentication bridge
│   │   ├── error/         # OAuth error handling
│   │   └── signin/        # Custom sign-in page
│   ├── documents/         # Document management routes
│   │   └── [id]/          # Individual document viewer
│   │       └── page.tsx   # Document display with selections
│   ├── globals.css        # Global styles and Tailwind imports
│   ├── layout.tsx         # Root layout with providers
│   ├── page.tsx           # Home page with auth-aware content
│   ├── error.tsx          # Global error boundary
│   └── providers.tsx      # Client-side providers (Auth, Query)
├── components/             # Reusable UI components
│   ├── AuthenticatedHome.tsx # Document search and creation UI
│   ├── ErrorBoundary.tsx  # Async error boundary component
│   ├── FeatureCards.tsx   # Feature showcase component
│   ├── GreetingSection.tsx # Interactive greeting with API
│   ├── Header.tsx         # Main navigation header
│   ├── MarkdownRenderer.tsx # Markdown with wiki links
│   ├── SelectionPopup.tsx # Selection creation interface
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

## Document Management Features

### For Authenticated Users

The frontend provides comprehensive document management capabilities:

#### Document Operations
- **Search**: Full-text search for documents by name with real-time results
- **Create**: Create new markdown documents with initial content
- **View**: Render markdown with syntax highlighting and wiki-style links
- **Navigate**: Click wiki links (`[[page name]]`) to navigate between documents

#### Selection System

Users can select any text within a document to create three types of selections:

##### 1. Highlights
- Mark important text passages for later reference
- Saved highlights appear in the document sidebar
- Visual indication with yellow background
- Persistent across sessions

##### 2. Document References
- Link selected text to other documents in the system
- Search for existing documents or create new ones on the fly
- Specify reference types:
  - **Citation**: Reference to source material
  - **Definition**: Link to defining document
  - **Elaboration**: Extended explanation
  - **Example**: Illustrative example
  - **Related**: Related concept or topic
- Referenced documents are accessible via the sidebar

##### 3. Entity References
- Mark text as referring to specific entities in your knowledge graph
- Pre-defined entity types:
  - Person, Organization, Location, Event
  - Concept, Product, Technology, Date
  - Custom entity types via "Other" option
- Build semantic relationships between documents

### Markdown Support

Full markdown rendering with extended features:
- **GitHub Flavored Markdown**: Tables, task lists, strikethrough
- **Wiki-style Links**: `[[page name]]` syntax for internal navigation
- **Syntax Highlighting**: Code blocks with language-specific highlighting
- **Interactive Elements**: Links open in new tabs, wiki links navigate internally

### User Interface Components

#### AuthenticatedHome
- Document search bar with live results
- Create new document button with modal
- Search results with content preview
- Personalized welcome message

#### Document Viewer
- Split-view layout: content area and sidebar
- Real-time display of highlights and references
- Text selection detection for creating new selections
- Navigation breadcrumbs and metadata

#### Selection Popup
- Multi-tab interface for different selection types
- Inline document search
- Entity type selection grid
- Reference type dropdown
- Create new documents from references

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

## API Integration

The frontend integrates with a comprehensive set of backend APIs:

### Document APIs
- `POST /api/documents` - Create new documents
- `GET /api/documents/:id` - Retrieve document by ID
- `PATCH /api/documents/:id` - Update document content/metadata
- `DELETE /api/documents/:id` - Delete document
- `GET /api/documents` - List all documents (paginated)
- `GET /api/documents/search?q=query` - Search documents by name
- `GET /api/documents/schema-description` - Natural language schema description
- `POST /api/documents/:id/llm-context` - Get LLM-suitable context for document
- `POST /api/documents/discover-context` - Discover graph context from text

### Selection APIs
- `POST /api/selections` - Create provisional selection
- `GET /api/selections/:id` - Get selection by ID
- `PATCH /api/selections/:id` - Update selection
- `DELETE /api/selections/:id` - Delete selection
- `GET /api/selections` - List selections (filtered)
- `POST /api/selections/highlight` - Save selection as highlight
- `POST /api/selections/resolve` - Link selection to document
- `POST /api/selections/create-document` - Create new document from selection
- `POST /api/selections/generate-document` - Generate document content (AI)
- `GET /api/selections/highlights/:documentId` - Get document's highlights
- `GET /api/selections/references/:documentId` - Get document's references

### Authentication APIs
- `POST /api/tokens/google` - Exchange Google OAuth token for JWT
- `GET /api/users/me` - Get current user info
- `POST /api/users/logout` - Logout user
- `GET /api/auth/session` - Get session status

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

Environment variables are configured automatically based on your environment configuration files in `/config/environments/`. 

1. **Add to environment JSON** in `/config/environments/[env].json`:
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

2. **Access in code** via validation schema in `src/lib/env.ts`:
```typescript
const envSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url(),
  NEXTAUTH_URL: z.string().url(),
});
```

3. **Deployment**: Environment variables are set automatically during deployment based on your configuration

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
# With SEMIONT_ENV set (e.g., export SEMIONT_ENV=local)

# Run all frontend tests with coverage
semiont test --service frontend

# Run specific test types for frontend
semiont test --service frontend --suite unit         # Unit tests only
semiont test --service frontend --suite integration  # Integration tests only
semiont test --service frontend --suite security    # Security tests only

# Override environment for staging tests
semiont test --environment staging --service frontend --suite integration

# Watch mode for development
semiont test --service frontend --suite unit --watch

# Skip coverage reporting for faster runs
semiont test --service frontend --no-coverage
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

- **Unit tests**: Fast execution by excluding integration tests
- **Integration tests**: Massive speedup for testing user flows
- **API tests**: Focuses on Next.js API routes
- **Security tests**: Authentication, GDPR compliance, and validation tests

### Test Stack

- **Test Runner**: [Vitest](https://vitest.dev/) - Fast, ESM-native test runner built on Vite
- **Testing Library**: [React Testing Library](https://testing-library.com/react) for component testing
- **API Mocking**: [MSW v2](https://mswjs.io/) for intercepting and mocking API requests
- **Assertions**: Vitest's built-in assertions + [@testing-library/jest-dom](https://github.com/testing-library/jest-dom)

### Current Test Coverage

- **100% test success rate** with all tests passing
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
└── app/
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

## Authentication System

### Overview

The frontend integrates with the backend's secure-by-default authentication model:

- **Google OAuth 2.0**: Primary authentication method via NextAuth.js
- **JWT Integration**: Automatic token management for backend API calls
- **Protected Routes**: Automatic redirection for unauthenticated users
- **Session Management**: Secure session handling with encrypted cookies

### Authentication Flow

1. **User Login**: Click "Sign In" button → redirects to Google OAuth
2. **OAuth Validation**: Google validates credentials and returns to `/api/auth/callback/google`
3. **Session Creation**: NextAuth.js creates encrypted session cookie
4. **Backend Integration**: Frontend automatically includes JWT in API requests
5. **Protected Access**: User can access authenticated features

**Note**: The OAuth callback URL must be configured in Google Cloud Console as:
- Production: `https://yourdomain.com/api/auth/callback/google`
- Development: `http://localhost:3000/api/auth/callback/google`

### Using Authentication in Components

```typescript
// Check authentication status
import { useAuth } from '@/hooks/useAuth';

export function MyComponent() {
  const { isAuthenticated, user } = useAuth();
  
  if (!isAuthenticated) {
    return <div>Please sign in to continue</div>;
  }
  
  return <div>Welcome, {user.email}!</div>;
}
```

### API Integration

The API client automatically handles authentication:

```typescript
// API calls automatically include JWT token
import { useSecureAPI } from '@/hooks/useSecureAPI';

export function DataComponent() {
  const { data, isLoading } = useSecureAPI('/api/data');
  
  // Token is automatically included in the request
  // No manual authentication handling needed
}
```

### MCP Authentication Bridge

The frontend provides a special authentication bridge for Model Context Protocol (MCP) clients:

- `GET /auth/mcp-setup?callback=<url>` - OAuth flow for MCP clients
  - Handles browser-based authentication using NextAuth session cookies
  - If user is not authenticated, redirects to Google OAuth sign-in
  - Once authenticated, calls backend to generate a 30-day refresh token
  - Redirects to callback URL with the refresh token as a query parameter
  - Used by MCP clients for initial authentication

This endpoint bridges the gap between browser-based OAuth (which uses cookies) and API-based authentication (which uses JWT tokens), allowing MCP clients to obtain valid tokens through a browser flow.

### Protected Routes

Routes requiring authentication are automatically protected:

```typescript
// app/dashboard/page.tsx
import { requireAuth } from '@/lib/auth';

export default async function DashboardPage() {
  await requireAuth(); // Redirects to sign-in if not authenticated
  
  return <Dashboard />;
}
```

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

## Contributing

### Development Setup Prerequisites
- Node.js 18+ with npm
- Understanding of React and TypeScript
- Familiarity with Next.js App Router

### Code Style Guidelines
- **Functional, side-effect free code is strongly preferred**
- Use functional components with hooks
- Avoid class components and mutations
- No unnecessary comments - code should be self-documenting
- Use descriptive component and variable names
- Follow existing patterns in the codebase
- Prefer composition over inheritance

### Testing Requirements
- All tests must pass before committing
- Run `npm test` to execute all tests
- Run `npm run test:unit` for faster unit-only testing
- New components should include appropriate tests

### Type Checking and Linting
```bash
# Type check all code
npm run type-check

# Build (includes type checking)
npm run build

# Run specific test suites
npm run test:unit        # Unit tests only
npm run test:integration # Integration tests only

# Performance analysis
npm run perf            # Full performance check
npm run analyze-bundle  # Bundle size analysis
```

### PR Requirements
- Tests must pass (all test suites)
- TypeScript must compile without errors (strict mode)
- Follow functional programming principles
- Include tests for new components
- Update documentation if UI changes significantly
- Check bundle size impact with `npm run analyze-bundle`

## Further Reading

- [Next.js 14 Documentation](https://nextjs.org/docs)
- [NextAuth.js Documentation](https://next-auth.js.org/)
- [TanStack Query Documentation](https://tanstack.com/query)
- [Tailwind CSS Documentation](https://tailwindcss.com/docs)
- [React Query Best Practices](https://tkdodo.eu/blog/practical-react-query)