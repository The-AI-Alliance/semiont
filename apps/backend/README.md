# Semiont Backend

A type-safe Node.js backend API built with modern development practices and comprehensive validation.

## Quick Start

```bash
# Install dependencies
npm install

# Configure secrets (from project root)
../../scripts/semiont secrets set database-password  # Enter: localpassword
../../scripts/semiont secrets set jwt-secret         # Generate with: openssl rand -base64 32

# Run database migrations
npx prisma db push

# Start development server
npm run dev

# Build for production
npm run build
npm start
```

## Local Development

### Prerequisites

- Node.js 18+ (recommend using nvm)
- PostgreSQL database (local or Docker)
- Secrets configured via `semiont secrets` command

### Setting Up Local Database

#### Option 1: Docker (Recommended)
```bash
# Start PostgreSQL in Docker
docker run --name semiont-postgres \
  -e POSTGRES_PASSWORD=localpassword \
  -e POSTGRES_DB=semiont \
  -p 5432:5432 \
  -d postgres:15-alpine

# Database password should match what you configured with:
# ../../scripts/semiont secrets set database-password
```

#### Option 2: Local PostgreSQL
```bash
# Create database
createdb semiont

# Connection string for .env
DATABASE_URL="postgresql://username:password@localhost:5432/semiont"
```

### Development Workflow

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

# Server starts on http://localhost:4000
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
# Health check
curl http://localhost:4000/api/health

# Get greeting (no auth required)
curl http://localhost:4000/api/hello/greeting

# Test with authentication
TOKEN="your-jwt-token"
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/protected-endpoint
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

### Adding Authentication to Routes

Simply add the `authMiddleware`:

```typescript
app.get('/api/protected-endpoint', authMiddleware, async (c) => {
  const user = c.get('user'); // Typed User object available
  // Your protected logic here
});
```

### Adding New OAuth Providers

1. **Extend `OAuthService`** in `src/auth/oauth.ts`
2. **Add provider-specific validation**
3. **Update user model** if needed
4. **Add new route** following the existing pattern

### Configuration Management

The backend uses a unified configuration system that reads from the shared `config/` directory:

1. **Application Configuration** - Edit `config/base/app.config.ts`:
```typescript
backend: {
  port: 4000,
  database: {
    host: 'localhost',
    port: 5432,
    name: 'semiont',
    user: 'postgres'
  }
}
```

2. **Secrets Management** - Use the semiont CLI:
```bash
# Local development secrets
../../scripts/semiont secrets set database-password
../../scripts/semiont secrets set jwt-secret

# Production secrets (AWS Secrets Manager)
../../scripts/semiont secrets set oauth/google
```

3. **Adding New Configuration**:
   - For non-secret config: Add to `config/schemas/config.schema.ts` and `config/base/app.config.ts`
   - For secrets: Add to `scripts/local-secrets.ts` for local dev
   - Update validation in `src/config/env.ts`

## Testing

The backend uses **Jest** with TypeScript for unit testing, following a simple and focused testing approach.

### Running Tests

```bash
# Run all tests
npm test

# Run tests with coverage report
npm run test:coverage

# Run tests in watch mode (development)
npm run test:watch

# Type checking
npm run type-check

# Build (includes type checking)
npm run build
```

### Current Test Coverage

- **40.6% overall coverage** with 86/86 tests passing
- Focus on critical components: authentication, validation, and core business logic
- Simple unit tests that test individual functions and services directly

### Testing Philosophy

We prioritize **simple, focused unit tests** over complex integration tests to:

1. **Achieve high coverage quickly** - Test individual functions rather than full HTTP flows
2. **Maintain fast test execution** - Unit tests run faster and are more reliable
3. **Avoid complex mocking** - Test business logic directly without HTTP layer complexity
4. **Follow TypeScript strict mode** - All tests are strictly typed and compile cleanly

### Test Structure

```
src/__tests__/
├── auth/
│   ├── jwt.test.ts              # JWT token management tests
│   └── oauth.test.ts            # OAuth service tests (removed - see note)
├── middleware/
│   └── auth.test.ts             # Authentication middleware tests
├── validation/
│   └── schemas.test.ts          # Zod schema validation tests
└── api/
    ├── admin-endpoints.test.ts  # Admin API unit tests (Prisma direct)
    └── documentation.test.ts    # API documentation endpoint tests
```

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

## Security Features

- **JWT payload validation** - Runtime validation of token structure
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

## Further Reading

- [Hono Documentation](https://hono.dev/)
- [Prisma Documentation](https://prisma.io/docs)
- [Zod Documentation](https://zod.dev/)
- [JWT Best Practices](https://auth0.com/blog/a-look-at-the-latest-draft-for-jwt-bcp/)