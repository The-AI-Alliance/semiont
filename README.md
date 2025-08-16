# Semiont - Semantic Knowledge Platform

An AI-powered semantic knowledge platform that automatically extracts knowledge graphs from unstructured content and constructs rich contextual understanding for agentic RAG systems. Semiont combines advanced NLP, entity recognition, and relationship extraction to transform documents into interconnected semantic networks that enable intelligent agents to reason over and retrieve contextually relevant information.

## 📁 File Layout

```
semiont/
├── apps/
│   ├── frontend/          # Next.js 14 frontend with React Query & NextAuth
│   │   ├── src/          # Source code with components, hooks, and API client
│   │   └── README.md     # Frontend development guide and patterns
│   └── backend/          # Hono backend API with Prisma ORM
│       ├── src/          # Type-safe API with JWT auth and validation
│       └── README.md     # Backend development guide and patterns
├── packages/             # Shared workspace packages  
│   ├── config-loader/   # Configuration loading and validation library
│   ├── scripts/         # Type-safe management and deployment scripts
│   ├── api-types/       # Shared TypeScript types
│   └── cloud/           # AWS CDK infrastructure (two-stack model)  
│       └── lib/
│           ├── infra-stack.ts # Infrastructure stack (VPC, RDS, EFS)
│           └── app-stack.ts   # Application stack (ECS, ALB, CloudFront)
├── bin/                  # Executable scripts
│   └── semiont          # Main management CLI tool
├── docs/                 # Comprehensive documentation
│   ├── DEPLOYMENT.md     # Step-by-step deployment guide
│   ├── ARCHITECTURE.md   # System architecture overview
│   ├── CONFIGURATION.md  # Configuration management guide
│   ├── DATABASE.md       # Database setup and management
│   ├── SECURITY.md       # Security controls and best practices
│   ├── RBAC.md          # Role-based access control details
│   ├── SCALING.md       # Performance and cost scaling guide
│   ├── TESTING.md       # Testing strategy and guidelines
│   ├── MAINTENANCE.md   # Operational maintenance procedures
│   └── TROUBLESHOOTING.md # Common issues and solutions
└── config/              # JSON configuration files (authoritative configuration data)
```

## 🚀 Quickstart

### Prerequisites
- Node.js 18+ (22+ recommended)
- npm 9+
- Docker or Podman (for local PostgreSQL containers)
- AWS CLI configured (for cloud deployment only)

### 1. Clone & Install
```bash
git clone https://github.com/The-AI-Alliance/semiont.git
cd semiont
npm install           # Install all workspace dependencies
npm run install:cli   # Install the semiont CLI globally
```

### 2. Initialize Your Project

```bash
# Initialize the project with configuration files
semiont init --name "my-project" --environments "local,staging,production"

# This creates:
# ✅ semiont.json - Main project configuration
# ✅ config/environments/*.json - Environment-specific configs
```

### 3. Instant Local Development 🎉

#### 🚀 Complete Development Environment (Recommended)
```bash
# Set default environment to avoid repetition
export SEMIONT_ENV=local

# One command starts everything!
semiont start

# This automatically:
# ✅ Starts PostgreSQL container with schema
# ✅ Starts backend API with proper database connection
# ✅ Starts frontend with real API integration
# 🎉 Ready to develop in ~30 seconds!
```

**Your services are running at:**
- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:3001
- **Database**: PostgreSQL in Docker container

#### 🎨 Frontend-Only Development (UI/UX Work)
```bash
# With SEMIONT_ENV=local already set:
semiont start --service frontend

# Perfect for:
# - Component development and styling
# - UI/UX iteration 
# - Design system work
```

#### ⚡ Service-Specific Development
```bash
# Backend only (auto-starts database)
semiont start --service backend

# Check what's running with interactive dashboard
semiont watch

# Check specific service logs
semiont watch logs frontend

# Stop everything
semiont stop
```

#### 📊 Real-time Monitoring (New!)
```bash
# Interactive dashboard with services, logs, and metrics
semiont watch

# Focus on log streaming
semiont watch logs

# Focus on performance metrics  
semiont watch metrics

# Filter to specific service
semiont watch logs frontend
```

### 4. Alternative Manual Setup

If you prefer manual environment setup:

#### Quick Start (No Backend Required)
```bash
# Frontend only with mock API
cd apps/frontend
npm run dev:mock  # Frontend on :3000 with mock API
```

#### Full Stack Development (Manual)
```bash
# Configure local secrets (first time only)
semiont configure local set database-password  # Enter: localpassword
semiont configure local set jwt-secret         # Generate with: openssl rand -base64 32

# Start PostgreSQL (Docker or Podman)
docker run --name semiont-postgres \
  -e POSTGRES_PASSWORD=localpassword \
  -e POSTGRES_DB=semiont \
  -p 5432:5432 \
  -d postgres:15-alpine

# Backend setup
cd apps/backend
npx prisma db push
npm run dev  # Backend on :3001

# Frontend setup (in new terminal)
cd apps/frontend
npm run dev  # Frontend on :3000
```

### 5. Configuration Setup

```bash
# View current configuration
semiont configure show

# Edit configuration with your values
# Update config/environments/development.json and config/environments/production.json with:
# - Your domain name
# - Site branding
# - OAuth settings
# - Email addresses

# Validate configuration
semiont configure validate
```

### 6. Build and Test
```bash
# Run comprehensive test suite
semiont test

# Run specific test types for targeted validation  
semiont test --service frontend --suite unit      # Fast frontend unit tests
semiont test --service backend --suite integration # Backend integration tests
semiont test --suite integration                  # Cross-service integration tests
semiont test --suite security                     # Security-focused validation

# Run tests against custom environments
semiont test --environment staging --suite integration  # Custom environment testing
```

### 7. AWS Deployment
```bash
# Set production environment
export SEMIONT_ENV=production

# Provision AWS infrastructure (one-time setup)
semiont provision

# Deploy application code and configuration
semiont deploy

# Start services (if needed)
semiont start

# Configure OAuth secrets (after deployment)
semiont configure set oauth/google

# Monitor deployment with real-time dashboard
semiont watch
```

**Note**: AWS credentials are detected automatically using the standard AWS credential chain (AWS CLI configuration, SSO, environment variables, etc.). If you need to configure credentials, run:
- `aws configure` for access keys
- `aws sso login` for AWS SSO

### 8. Service Management
```bash
# For production (with SEMIONT_ENV=production)
semiont deploy
semiont start --service backend
semiont restart --service all

# Or override environment as needed
semiont stop --environment staging --service frontend

# Test before deployment
semiont test
```

### 9. Monitor & Verify Deployment
```bash
# Interactive real-time dashboard (recommended)
semiont watch

# Focus on specific monitoring
semiont watch logs          # Log streaming
semiont watch metrics       # Performance metrics

# Legacy status check
semiont check
```

## 📖 Documentation

### Development Guides

| Document | Description |
|----------|-------------|
| [Frontend README](apps/frontend/README.md) | Next.js development guide, patterns, and API integration |
| [Frontend Performance](apps/frontend/docs/PERFORMANCE.md) | Frontend performance optimization guide |
| [Backend README](apps/backend/README.md) | Hono API development guide, type safety, and database patterns |
| [Scripts README](packages/scripts/README.md) | Management CLI architecture, security features, and interactive dashboards |
| [Config Loader README](packages/config-loader/README.md) | Configuration system architecture and environment management |
| [Cloud README](packages/cloud/README.md) | AWS CDK infrastructure setup and deployment |

### System Documentation

| Document | Description |
|----------|-------------|
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Complete deployment guide with validation steps |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture and design decisions |
| [CONFIGURATION.md](docs/CONFIGURATION.md) | Configuration management and environment setup |
| [DATABASE.md](docs/DATABASE.md) | Database setup, migrations, and management |
| [TESTING.md](docs/TESTING.md) | Testing strategy, frameworks, and best practices |

### Operations & Security

| Document | Description |
|----------|-------------|
| [SECURITY.md](docs/SECURITY.md) | Security controls, compliance, and best practices |
| [RBAC.md](docs/RBAC.md) | Role-based access control implementation |
| [SCALING.md](docs/SCALING.md) | Performance scaling and cost optimization |
| [MAINTENANCE.md](docs/MAINTENANCE.md) | Operational maintenance procedures |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common issues and diagnostic commands |

## 🏗️ Architecture

### Application Layer
- **Frontend**: Next.js 14 with App Router, React Query, NextAuth.js OAuth, and Tailwind CSS
- **Backend**: Type-safe Hono API with Prisma ORM, JWT authentication, and Zod validation
- **Database**: PostgreSQL with Prisma ORM for type-safe database access

### Infrastructure Layer
- **Compute**: AWS ECS Fargate with auto-scaling and health checks
- **Load Balancing**: Application Load Balancer with SSL termination
- **Storage**: RDS PostgreSQL + EFS for persistent file storage
- **CDN**: CloudFront distribution for static assets
- **Security**: WAF with rate limiting, VPC isolation, encrypted storage
- **Monitoring**: CloudWatch metrics, SNS alerts, structured logging

### Management Layer
- **Infrastructure as Code**: AWS CDK with TypeScript (two-stack architecture)
- **Management Scripts**: Type-safe CLI tools with security validation and command injection prevention
- **CI/CD**: Automated deployment with health checks and rollback capabilities
- **Performance**: Bundle analysis, Lighthouse CI, and performance monitoring

For detailed architecture information, see [ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Configuration System

Semiont uses a unified JSON-based configuration system with inheritance that provides:
- **Type Safety**: All configuration validated at runtime with TypeScript interfaces
- **Environment Management**: Separate JSON configs for each environment with inheritance
- **Configuration Inheritance**: Use `_extends` field to build on base configurations
- **Centralized Settings**: Domain, OAuth, AWS resources all configured in one place
- **Secure Secrets**: Local secrets managed via `semiont configure` command (not in files)

The system uses a clear separation between configuration data and loading logic:
- **Configuration Data**: JSON files in `config/environments/` (development.json, production.json)
- **Configuration Loader**: TypeScript package in `packages/config-loader/` for loading and validation
- **Inheritance**: JSON configurations extend base configs using `_extends` field
- **Secrets**: Managed via `semiont configure` command for local development
- **Production**: Secrets automatically injected from AWS Secrets Manager

No more `.env` files - everything is type-safe, centralized, and inheritable!

## 🛠️ Development

### Local Development Options

#### 🎨 Frontend-Only Development (Fastest)
```bash
cd apps/frontend
npm run dev:mock  # Includes mock API server
```
Perfect for UI/UX work, component development, and styling changes.

#### 🔧 Full-Stack Development
```bash
# Terminal 1: Backend
cd apps/backend && npm run dev

# Terminal 2: Frontend
cd apps/frontend && npm run dev
```
Required for API development, database changes, and integration work.

#### 🚀 Turbo Mode (Experimental)
```bash
cd apps/frontend
npm run dev:fast  # Uses Next.js Turbopack
```
Faster builds for large codebases (requires backend running).

### Development Guides

#### For Frontend Development
Start with the [Frontend README](apps/frontend/README.md) to understand:
- Next.js 14 App Router patterns
- Type-safe API integration with React Query
- Authentication flow with NextAuth.js
- Component architecture and error boundaries
- Performance optimization and monitoring
- **Local development with mock API**

#### For Backend Development  
Start with the [Backend README](apps/backend/README.md) to understand:
- Hono API development patterns
- Type-safe database operations with Prisma
- JWT authentication and validation
- Request/response validation with Zod
- **Docker PostgreSQL setup for local development**
- **Prisma Studio for database visualization**

#### For Infrastructure & DevOps
Start with the [Scripts README](packages/scripts/README.md) to understand:
- Management CLI architecture and security features
- Interactive monitoring dashboards with React/Ink
- AWS resource management and real-time monitoring
- Deployment automation and health checks
- Performance analysis and cost optimization

### Key Development Principles

1. **Type Safety First**: Full TypeScript coverage from database to UI with strict mode enabled
2. **Functional Programming**: Prefer pure, side-effect free functions throughout the codebase
3. **Security by Default**: Input validation, command injection prevention, sensitive data redaction
4. **Performance Optimized**: Bundle analysis, Lighthouse CI, performance monitoring
5. **Error Resilience**: Comprehensive error boundaries and graceful degradation
6. **Developer Experience**: Auto-completion, inline documentation, hot reloading

### TypeScript Configuration

The project uses a strict TypeScript configuration with all safety features enabled:
- Root `tsconfig.json` with strict settings that all packages extend
- `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes` all enabled
- Apps use `moduleResolution: "bundler"` for modern imports
- Packages use `moduleResolution: "node"` for compatibility
- All code must compile without errors before merging

## 🧪 Testing

The project uses modern testing frameworks with intelligent test type filtering:

- **Frontend**: Vitest + MSW v2 + React Testing Library with comprehensive test coverage
- **Backend**: Vitest with unit and integration tests for all critical paths
- **CLI**: Vitest with tests for all commands and deployment types
- **All packages**: Strict TypeScript compilation catches errors at build time

### Test Type Organization

Semiont organizes tests into four distinct categories for targeted testing:

- **🧩 Unit Tests**: Individual components, functions, hooks (~1007 frontend, ~176 backend)
- **🔗 Integration Tests**: Multi-component workflows, API endpoints, and service interactions (~82 frontend, ~101 backend)
- **🔒 Security Tests**: Authentication, validation, GDPR compliance (~5 across both apps)
- **🌐 E2E Tests**: End-to-end user workflows across services

### Running Tests

#### Using Semiont CLI (Recommended)

```bash
# Run all tests with coverage (default)
semiont test

# Run by service
semiont test --service frontend           # Frontend only
semiont test --service backend            # Backend only
semiont test --service all                # Both services (default)

# Run by test suite
semiont test --suite unit               # Unit tests only
semiont test --suite integration        # Integration tests only
semiont test --suite security          # Security tests only
semiont test --suite e2e               # End-to-end tests only

# Combine service and test suite
semiont test --service frontend --suite unit     # Frontend unit tests
semiont test --service backend --suite integration # Backend integration tests

# Additional options
semiont test --no-coverage     # Skip coverage for speed
semiont test --watch           # Watch mode
semiont test --verbose         # Detailed output
```

#### Direct npm Scripts

```bash
# Run all tests
npm test  # From root directory

# Frontend tests (apps/frontend/)
npm test                    # All tests
npm run test:unit          # Unit tests only  
npm run test:integration   # Integration workflow tests
npm run test:api           # API route tests (subset of integration)
npm run test:security      # Security tests only
npm run test:coverage      # All tests with coverage
npm run test:watch         # Watch mode

# Backend tests (apps/backend/)
npm test                    # All tests
npm run test:unit          # Unit tests only
npm run test:integration   # Integration workflow tests
npm run test:api           # API endpoint tests (subset of integration)
npm run test:security      # Security tests only
npm run test:coverage      # All tests with coverage
npm run test:watch         # Watch mode
```

**Note**: The `test:api` npm scripts test specific API routes/endpoints and are a subset of integration testing. When using the Semiont CLI, API tests are included in the `--suite integration` category.

#### Performance Benefits

Targeted test execution provides significant performance improvements:
- **Unit tests**: Excludes integration tests for faster feedback (~1183 focused tests)
- **Integration tests**: Focused on workflows and API endpoints (~183 targeted tests)
- **Security tests**: Runs only security-critical validations (~5 focused tests)
- **E2E tests**: Complete user workflows for staging/production validation

### Test Coverage & Quality

The testing strategy emphasizes:
- **Type Safety**: TypeScript catches errors at compile time
- **Network-Level Mocking**: MSW v2 provides realistic API mocking
- **User-Focused Testing**: Tests user behavior, not implementation details
- **Performance Testing**: Lighthouse CI and bundle analysis catch regressions
- **Security Testing**: Dedicated tests for authentication, GDPR compliance, and validation

See [Testing Documentation](./docs/TESTING.md) and app-specific READMEs for detailed testing strategies.

## 📜 License

Apache 2.0 - See [LICENSE](LICENSE) for details.