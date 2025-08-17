# Semiont Backend

A type-safe Node.js backend API built with modern development practices and comprehensive validation.

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

# Run database migrations
npx prisma db push

# Start development server (with auto-restart on changes)
npm run dev

# Build for production (usually not needed - see note below)
npm run build
npm start
```

**Note on Building**: For local development, you don't need to build - use `npm run dev` for auto-restart. For production deployment, `semiont deploy` handles building automatically. See [DEPLOYMENT.md](../../docs/DEPLOYMENT.md) for details.

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

# Service-specific commands
semiont start --service database  # Start PostgreSQL container
semiont start --service backend   # Start backend (auto-starts database if needed)
semiont start --service frontend  # Start frontend only
semiont stop --service backend    # Stop backend service
semiont restart --service backend # Restart backend with fresh connection
```

### Why Use Semiont CLI?

- **🔄 Smart Dependencies**: Frontend auto-starts backend, backend auto-starts database  
- **📦 Consistent Environment**: Everyone gets identical PostgreSQL setup
- **⚡ Zero Configuration**: No manual database setup, connection strings, or environment variables
- **🧹 Easy Reset**: Corrupted data? `--reset` gives you a fresh start
- **🎯 Focused Development**: Start only what you need
- **🐳 Container Runtime Flexibility**: Works with Docker or Podman (auto-detected)

### Development Workflow with Semiont CLI

1. **First time setup** (run once):
```bash
cd /your/project/root
npm install  # Installs dependencies for all apps
semiont init --name "my-project"  # Initialize configuration
export SEMIONT_ENV=local  # Set default environment
```

2. **Daily development** (typical workflow):
```bash
# Start everything for full-stack development
semiont start

# Your services are now running! Develop normally...
# Frontend: http://localhost:3000
# Backend: http://localhost:3001  
# Database: Managed automatically

# When done developing
semiont stop
```

3. **Backend-only development**:
```bash
semiont local backend start
# Only database + backend running
```

4. **Frontend with mock API**:
```bash  
semiont local frontend start --mock
# Only frontend running, no backend needed
```

5. **Fresh start** (reset database):
```bash
semiont local start --reset
# Clean database with sample data
```

### Container Runtime Options

The Semiont CLI automatically detects and works with both **Docker** and **Podman**:

#### Using Podman Instead of Docker

For better security and performance, you can use Podman:

**Linux Setup (Recommended):**
```bash
# 1. Install Podman (if not already installed)
sudo apt install podman  # Ubuntu/Debian
sudo dnf install podman  # Fedora/RHEL

# 2. Enable rootless Podman socket
systemctl --user enable --now podman.socket

# 3. Set environment variables
export DOCKER_HOST="unix:///run/user/$(id -u)/podman/podman.sock"
export TESTCONTAINERS_RYUK_DISABLED=true

# 4. Use Semiont CLI normally - it will detect Podman automatically
semiont local start
```

**macOS Setup:**
```bash
# 1. Install Podman via Homebrew
brew install podman

# 2. Initialize Podman machine
podman machine init
podman machine start

# 3. Configure environment
export DOCKER_HOST="$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')"
export TESTCONTAINERS_RYUK_DISABLED=true

# 4. Use normally
semiont local start
```

**Benefits of Using Podman:**
- **Enhanced Security**: Rootless containers by default (no root daemon)
- **Better Performance**: No VM overhead on Linux systems
- **Lower Resource Usage**: More efficient than Docker Desktop
- **No Background Daemon**: Containers run without persistent daemon

The Semiont CLI will automatically detect your container runtime and configure accordingly.

### Traditional Manual Setup (Alternative)

If you prefer manual setup or need to understand the internals:

#### Prerequisites

- Node.js 18+ (recommend using nvm) 
- Docker (for PostgreSQL container)
- Secrets configured via `semiont secrets` command

#### Manual Database Setup

**Option 1: Manual Docker (if not using Semiont CLI)**
```bash
# Start PostgreSQL in Docker
docker run --name semiont-postgres-dev \
  -e POSTGRES_PASSWORD=dev_password \
  -e POSTGRES_DB=semiont_dev \
  -e POSTGRES_USER=dev_user \
  -p 5432:5432 \
  -d postgres:15-alpine
```

**Option 2: Local PostgreSQL**
```bash
# Create database
createdb semiont_dev

# Connection string for .env
DATABASE_URL="postgresql://dev_user:dev_password@localhost:5432/semiont_dev"
```

#### Manual Development Workflow

1. **Initial Setup**
```bash
# Clone and install
cd apps/backend
npm install

# Configure environment
cp .env.example .env
# Edit .env with your local settings

# Initialize database
npx prisma generate
npx prisma db push
```

2. **Start Development Server**
```bash
# Run with hot reload
npm run dev

# Server starts on http://localhost:3001
```

3. **Database Development**
```bash
# Open Prisma Studio (database GUI)
npx prisma studio

# Reset database (caution: deletes all data)
npx prisma db push --force-reset

# Generate Prisma client after schema changes
npx prisma generate
```

### Environment Configuration

Create `.env` file with these local development settings:

```env
# Server
NODE_ENV=development
PORT=4000

# Database
DATABASE_URL="postgresql://postgres:localpassword@localhost:5432/semiont"

# JWT (use a long random string for local dev)
JWT_SECRET="local-development-secret-min-32-characters-long"
JWT_EXPIRES_IN="7d"

# OAuth (optional for local dev)
GOOGLE_CLIENT_ID="your-google-client-id"
GOOGLE_CLIENT_SECRET="your-google-client-secret"

# Frontend URL
FRONTEND_URL="http://localhost:3000"
```

### Testing API Endpoints

```bash
# Health check (no auth required - for ALB health checks)
curl http://localhost:4000/api/health

# API documentation (no auth required)
curl http://localhost:4000/api

# Test greeting endpoint (requires authentication)
TOKEN="your-jwt-token"
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/hello

# Test status endpoint (requires authentication)
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/status
```

### Development Tools

#### Prisma Studio
Visual database editor:
```bash
npx prisma studio
# Opens at http://localhost:5555
```

#### API Testing
Recommended tools:
- [HTTPie](https://httpie.io/) - Command line HTTP client
- [Postman](https://www.postman.com/) - GUI API testing
- [Thunder Client](https://marketplace.visualstudio.com/items?itemName=rangav.vscode-thunder-client) - VS Code extension

#### Database Migrations
```bash
# Create migration from schema changes
npx prisma migrate dev --name add_user_role

# Apply migrations
npx prisma migrate deploy

# Reset database
npx prisma migrate reset
```

### Common Development Tasks

#### Adding Test Data
Create `prisma/seed.ts`:
```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.user.create({
    data: {
      email: 'test@example.com',
      name: 'Test User',
      provider: 'google',
      providerId: 'test-id',
    },
  });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

Run: `npx ts-node prisma/seed.ts`

#### Debugging

1. **VS Code Debug Configuration**
Add to `.vscode/launch.json`:
```json
{
  "type": "node",
  "request": "launch",
  "name": "Debug Backend",
  "runtimeExecutable": "npm",
  "runtimeArgs": ["run", "dev"],
  "cwd": "${workspaceFolder}/apps/backend",
  "console": "integratedTerminal"
}
```

2. **Enable Debug Logging**
```env
# In .env
DEBUG=hono:*
PRISMA_LOG=query,info,warn,error
```

3. **Inspect Database Queries**
```typescript
// Temporarily add to see SQL queries
const prisma = new PrismaClient({
  log: ['query', 'info', 'warn', 'error'],
});
```

### Performance Tips

1. **Database Connection Pooling**
   - Prisma handles this automatically
   - Default pool size: 10 connections

2. **Hot Reload Optimization**
   - Use `npm run dev` for file watching
   - Nodemon restarts only on file changes

3. **Type Checking**
   - Run `npm run type-check` periodically
   - VS Code shows errors in real-time

### Troubleshooting

#### "Cannot connect to database"
```bash
# Check PostgreSQL is running
docker ps | grep postgres

# Test connection
psql $DATABASE_URL -c "SELECT 1"

# Check connection string format
echo $DATABASE_URL
```

#### "JWT_SECRET too short"
- Must be at least 32 characters
- Generate secure secret: `openssl rand -base64 32`

#### "Prisma client not found"
```bash
# Regenerate Prisma client
npx prisma generate

# Clear node_modules and reinstall
rm -rf node_modules
npm install
```

#### "Port already in use"
```bash
# Find process using port 4000
lsof -i :4000

# Kill process
kill -9 <PID>
```

## Technology Stack

- **Runtime**: Node.js with TypeScript
- **Web Framework**: [Hono](https://hono.dev/) - Fast, lightweight, and type-safe
- **Database**: PostgreSQL with [Prisma ORM](https://prisma.io/)
- **Authentication**: JWT with OAuth 2.0 (Google)
- **Validation**: [Zod](https://zod.dev/) for runtime type validation
- **Environment**: Strict environment variable validation

## Project Structure

```
src/
├── auth/                   # Authentication & authorization
│   ├── jwt.ts             # JWT token management with validation
│   └── oauth.ts           # OAuth providers (Google)
├── client/                # API client generation
│   └── api-client.ts      # Type-safe API client for frontend
├── config/                # Configuration management
│   └── env.ts             # Environment variable validation
├── middleware/            # HTTP middleware
│   └── auth.ts            # Authentication middleware
├── types/                 # Type definitions
│   ├── api.ts             # API request/response types
│   └── routes.ts          # Route type registry
├── validation/            # Runtime validation schemas
│   └── schemas.ts         # Zod validation schemas
├── config.ts              # Application configuration
├── db.ts                  # Database connection
└── index.ts               # Main application entry point

prisma/
└── schema.prisma          # Database schema definition
```

## Core Design Decisions

### 1. Type Safety First

We prioritize type safety throughout the application:

```typescript
// All API responses are typed
app.get('/api/status', (c) => {
  return c.json<StatusResponse>({
    status: 'operational',
    version: '0.1.0',
    // TypeScript ensures all required fields are present
  });
});
```

### 2. Runtime Validation with Zod

All incoming data is validated at runtime:

```typescript
// Request validation
const validation = validateData(GoogleAuthSchema, body);
if (!validation.success) {
  return c.json<ErrorResponse>({ 
    error: 'Invalid request body', 
    details: validation.details 
  }, 400);
}
```

### 3. Environment Variable Validation

Environment variables are validated at startup:

```typescript
// src/config/env.ts
const envSchema = z.object({
  JWT_SECRET: z.string().min(32),
  DATABASE_URL: z.string().url(),
  // Fail fast if configuration is invalid
});
```

### 4. Comprehensive JWT Security

Multi-layer JWT validation:

```typescript
// 1. Signature verification
// 2. Payload structure validation
// 3. Expiration checking
// 4. Custom business logic validation
const payload = JWTService.verifyToken(token);
```

### 5. API Route Type Registry

Centralized route definitions enable type-safe client generation:

```typescript
// src/types/routes.ts
export interface APIRoutes {
  '/api/auth/google': {
    POST: {
      body: { access_token: string };
      response: AuthResponse;
    };
  };
}
```

## Common Development Tasks

### Adding a New API Endpoint

1. **Define types** in `src/types/api.ts`:
```typescript
export interface CreatePostRequest {
  title: string;
  content: string;
}

export interface CreatePostResponse {
  id: string;
  title: string;
  createdAt: string;
}
```

2. **Add route definition** in `src/types/routes.ts`:
```typescript
'/api/posts': {
  POST: {
    body: CreatePostRequest;
    response: CreatePostResponse;
  };
}
```

3. **Create validation schema** in `src/validation/schemas.ts`:
```typescript
export const CreatePostSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(10000),
});
```

4. **Implement route** in `src/index.ts`:
```typescript
app.post('/api/posts', authMiddleware, async (c) => {
  const body = await c.req.json();
  const validation = validateData(CreatePostSchema, body);
  
  if (!validation.success) {
    return c.json<ErrorResponse>({ 
      error: 'Invalid request', 
      details: validation.details 
    }, 400);
  }

  // Implementation logic here
  return c.json<CreatePostResponse>({ /* response */ });
});
```

5. **Update API client** in `src/client/api-client.ts`:
```typescript
export const api = {
  posts: {
    create: (data: CreatePostRequest): Promise<CreatePostResponse> =>
      apiClient.post('/api/posts', { body: data }),
  },
};
```

### Adding Database Models

1. **Update Prisma schema** in `prisma/schema.prisma`:
```prisma
model Post {
  id        String   @id @default(cuid())
  title     String
  content   String
  authorId  String
  author    User     @relation(fields: [authorId], references: [id])
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

2. **Generate Prisma client**:
```bash
npx prisma generate
npx prisma db push
```

3. **Use in your routes**:
```typescript
const post = await prisma.post.create({
  data: {
    title: validation.data.title,
    content: validation.data.content,
    authorId: user.id,
  },
});
```

### Authentication for New Routes

**All routes are automatically protected by default!** Authentication is applied globally to all `/api/*` routes except those explicitly allowed.

```typescript
// This route is AUTOMATICALLY protected (no authMiddleware needed)
app.get('/api/my-new-endpoint', async (c) => {
  const user = c.get('user'); // User is available because auth is automatic
  // Your protected logic here
});

// To make a route PUBLIC (no auth), add it to PUBLIC_ENDPOINTS array:
const PUBLIC_ENDPOINTS = [
  '/api/health',
  '/api/auth/google',
  // '/api/my-public-endpoint',  // Add your public endpoint here
  '/api',
];
```

**Important**: New routes are protected by default. Only add to `PUBLIC_ENDPOINTS` if the route truly needs to be public (like health checks).

### Adding New OAuth Providers

1. **Extend `OAuthService`** in `src/auth/oauth.ts`
2. **Add provider-specific validation**
3. **Update user model** if needed
4. **Add new route** following the existing pattern

### Configuration Management

The backend uses environment-specific configuration files from `/config/environments/`:

1. **Environment Configuration** - Edit `/config/environments/[env].json`:
```json
{
  "services": {
    "backend": {
      "port": 3001,
      "deployment": { "type": "aws" }
    },
    "database": {
      "name": "semiont_prod",
      "deployment": { "type": "aws" }
    }
  },
  "aws": {
    "region": "us-east-2",
    "accountId": "123456789012"
  }
}
```

2. **Secrets Management** - Use the semiont CLI:
```bash
# Production secrets (AWS Secrets Manager)
semiont configure production set oauth/google
semiont configure staging set jwt-secret

# Check secret status
semiont configure production get oauth/google
```

3. **Adding New Configuration**:
   - Add to appropriate environment JSON file in `/config/environments/`
   - Update validation in `src/config/env.ts` if needed
   - Configuration is loaded automatically based on SEMIONT_ENV

## Testing

The backend uses **Jest** with TypeScript for unit testing, following a simple and focused testing approach.

### Running Tests

#### Using Semiont CLI (Recommended)

```bash
# With SEMIONT_ENV set (e.g., export SEMIONT_ENV=local)

# Run all backend tests with coverage
semiont test --service backend

# Run specific test types for backend
semiont test --service backend --suite unit         # Unit tests only
semiont test --service backend --suite integration  # Integration tests only
semiont test --service backend --suite security    # Security tests only

# Watch mode for development
semiont test --service backend --suite unit --watch

# Skip coverage reporting for faster runs
semiont test --service backend --no-coverage
```

#### Direct npm Scripts

```bash
# Run all tests
npm test

# Run specific test types
npm run test:unit          # Unit tests (excludes integration tests)
npm run test:integration   # Integration tests only (contract tests, etc.)
npm run test:api           # API endpoint tests only
npm run test:security      # Security-focused tests only

# Run tests with coverage report
npm run test:coverage

# Run tests in watch mode (development)
npm run test:watch

# Type checking
npm run type-check

# Build (includes type checking)
npm run build
```

#### Performance Benefits

Specific test type filtering provides significant performance improvements:

- **Unit tests**: Fast execution by excluding integration tests
- **Integration tests**: Focuses on contract testing and multi-service flows
- **API tests**: Validates endpoint behavior and responses
- **Security tests**: Tests focused on JWT validation, auth middleware, and input sanitization

### Current Test Coverage

- Focus on critical components: authentication, validation, and core business logic
- Simple unit tests that test individual functions and services directly
- All tests passing with comprehensive coverage of key paths

### Testing Philosophy

We prioritize **simple, focused unit tests** over complex integration tests to:

1. **Achieve high coverage quickly** - Test individual functions rather than full HTTP flows
2. **Maintain fast test execution** - Unit tests run faster and are more reliable
3. **Avoid complex mocking** - Test business logic directly without HTTP layer complexity
4. **Follow TypeScript strict mode** - All tests are strictly typed and compile cleanly

### Test Structure

Tests are organized by type for efficient targeted testing:

#### 🧩 Unit Tests
```
src/__tests__/
├── auth/
│   ├── jwt.test.ts              # JWT token management tests
│   └── oauth.test.ts            # OAuth service tests
├── middleware/
│   └── auth.test.ts             # Authentication middleware tests
├── validation/
│   └── schemas.test.ts          # Zod schema validation tests
├── config/
│   ├── config.test.ts           # Configuration validation tests
│   └── env.test.ts              # Environment variable tests
└── db.test.ts                   # Database connection tests
```

#### 🔗 Integration Tests
```
src/__tests__/
└── integration/
    ├── api-endpoints.test.ts    # Multi-service API flows
    └── contract-tests.test.ts   # API contract validation
```

#### 🌐 API Tests
```
src/__tests__/
└── api/
    ├── admin-endpoints.test.ts  # Admin API endpoint tests
    └── documentation.test.ts    # API documentation tests
```

#### 🔒 Security Tests
Security-focused tests are identified by naming pattern (`*security*`) and test:
- JWT validation and token security
- Authentication middleware behavior
- Input validation and sanitization
- Database access controls

### Testing Patterns

**Simple Unit Tests** - Test functions directly without HTTP layer:
```typescript
// Good: Direct function testing
describe('JWTService', () => {
  beforeEach(() => {
    // Set test environment
    process.env.SEMIONT_ENV = 'test';
  });

  it('should validate allowed domains correctly', () => {
    // Uses test environment configuration (test.example.com, example.org)
    expect(JWTService.isAllowedDomain('user@test.example.com')).toBe(true);
    expect(JWTService.isAllowedDomain('user@example.org')).toBe(true);
    expect(JWTService.isAllowedDomain('invalid@notallowed.com')).toBe(false);
  });
});
```

**Prisma Unit Tests** - Test database operations directly:
```typescript
// Good: Direct Prisma testing
describe('Admin User Operations', () => {
  it('should find users correctly', async () => {
    const users = await prisma.user.findMany();
    expect(Array.isArray(users)).toBe(true);
  });
});
```

**Avoid Complex Integration Tests** - These often fail due to mocking complexity:
```typescript
// Avoided: Complex HTTP + OAuth mocking
// These tests were removed due to ES6 module mocking issues
```

### Key Testing Components

1. **JWT Service** (`jwt.test.ts`) - Token creation, validation, domain checking
2. **Validation Schemas** (`schemas.test.ts`) - 100% coverage of Zod schemas
3. **Auth Middleware** (`auth.test.ts`) - Token validation and user context
4. **Admin Operations** (`admin-endpoints.test.ts`) - User management via Prisma
5. **API Documentation** (`documentation.test.ts`) - Endpoint documentation logic

### Test Environment Setup

Tests use the same strict TypeScript configuration as the main application:
- Strict type checking enabled
- All test files must compile without errors
- Comprehensive type safety throughout test suite

### Manual API Testing

```bash
# Test API endpoints manually
curl http://localhost:4000/api/status
curl http://localhost:4000/api/health
curl http://localhost:4000/api -H "Accept: application/json"
```

## Authentication & Security

### Authentication Model

The backend implements a **secure-by-default** authentication model:

- **All API routes require authentication by default**
- **Explicit list for public endpoints**
- **JWT Bearer token authentication**
- **Google OAuth 2.0 for user login**

### Public Endpoints (No Authentication Required)

Only these endpoints are accessible without authentication:

- `GET /api/health` - Health check for AWS ALB/ELB monitoring
- `GET /api` - API documentation endpoint
- `POST /api/auth/google` - OAuth login initiation

### Protected Endpoints

All other endpoints require a valid JWT token in the Authorization header:

```bash
# Example authenticated request
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  http://localhost:4000/api/hello
```

### How Authentication Works

1. **User logs in via Google OAuth**:
   ```bash
   POST /api/auth/google
   { "access_token": "google-oauth-token" }
   ```

2. **Backend validates Google token and returns JWT**:
   ```json
   {
     "success": true,
     "token": "jwt-token-here",
     "user": { /* user details */ }
   }
   ```

3. **Client includes JWT in subsequent requests**:
   ```bash
   Authorization: Bearer jwt-token-here
   ```

4. **Middleware validates JWT on every request**:
   - Checks token signature
   - Validates token expiration
   - Verifies user exists and is active
   - Adds user context to request

### Admin Endpoints

Admin endpoints require both authentication AND admin privileges:

- User must be authenticated (valid JWT)
- User must have `isAdmin: true` in database
- Returns 403 Forbidden if not admin

### Security Features

- **JWT payload validation** - Runtime validation of token structure
- **Automatic authentication** - All routes protected by default
- **Environment variable validation** - Fail-fast on misconfiguration  
- **Request validation** - All inputs validated with Zod schemas
- **SQL injection prevention** - Prisma ORM with parameterized queries
- **CORS configuration** - Properly configured for frontend domain
- **Domain restrictions** - OAuth limited to allowed domains

## Architecture Benefits

1. **Type Safety**: Catch errors at compile time, not runtime
2. **Validation**: Comprehensive input validation prevents invalid data
3. **Maintainability**: Clear structure and consistent patterns
4. **Developer Experience**: Auto-completion and inline documentation
5. **API Client Generation**: Frontend gets typed API client automatically
6. **Security**: Multiple layers of validation and authentication

## Debugging Tips

- **Database queries**: Enable Prisma query logging in development
- **JWT issues**: Check `src/auth/jwt.ts` for detailed error messages
- **Validation errors**: Zod provides detailed error paths
- **Environment issues**: Errors shown at startup with specific missing variables

## Contributing

### Development Setup Prerequisites
- Node.js 18+ with npm
- Docker or Podman for database containers
- TypeScript knowledge required

### Code Style Guidelines
- **Functional, side-effect free code is strongly preferred**
- Write pure functions whenever possible
- Avoid mutations and global state
- No unnecessary comments - code should be self-documenting
- Use descriptive variable and function names
- Follow existing patterns in the codebase

### Testing Requirements
- All tests must pass before committing
- Run `npm test` to execute all tests
- Run `npm run test:unit` for faster unit-only testing
- New features should include appropriate tests

### Type Checking and Linting
```bash
# Type check all code
npm run type-check

# Build (includes type checking)
npm run build

# Run specific test suites
npm run test:unit        # Unit tests only
npm run test:integration # Integration tests only
```

### PR Requirements
- Tests must pass (all test suites)
- TypeScript must compile without errors (strict mode)
- Follow functional programming principles
- Include tests for new functionality
- Update documentation if API changes

## Further Reading

- [Hono Documentation](https://hono.dev/)
- [Prisma Documentation](https://prisma.io/docs)
- [Zod Documentation](https://zod.dev/)
- [JWT Best Practices](https://auth0.com/blog/a-look-at-the-latest-draft-for-jwt-bcp/)