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
├── cdk/                  # AWS CDK infrastructure (two-stack model)
│   └── lib/
│       ├── infra-stack.ts # Infrastructure stack (VPC, RDS, EFS)
│       └── app-stack.ts   # Application stack (ECS, ALB, CloudFront)
├── scripts/              # Type-safe management and deployment scripts
│   ├── lib/             # Security utilities (logging, validation, command execution)
│   ├── semiont          # Main management CLI tool
│   └── README.md        # Scripts architecture and security features
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
├── config/              # Configuration management
│   └── README.md        # Configuration architecture and usage
└── packages/            # Shared packages (future)
```

## 🚀 Quickstart

### Prerequisites
- Node.js 18+ (22+ recommended)
- npm 9+
- Docker (for local database and deployment)
- AWS CLI configured (for cloud deployment)

### 1. Clone & Install
```bash
git clone https://github.com/The-AI-Alliance/semiont.git
cd semiont
npm install  # Installs all workspace dependencies
```

### 2. Local Development

#### Quick Start (No Backend Required)
```bash
# Frontend only with mock API
cd apps/frontend
npm run dev:mock  # Frontend on :3000 with mock API
```

#### Full Stack Development
```bash
# Configure local secrets (first time only)
./scripts/semiont secrets set database-password  # Enter: localpassword
./scripts/semiont secrets set jwt-secret         # Generate with: openssl rand -base64 32

# Start PostgreSQL (Docker)
docker run --name semiont-postgres \
  -e POSTGRES_PASSWORD=localpassword \
  -e POSTGRES_DB=semiont \
  -p 5432:5432 \
  -d postgres:15-alpine

# Backend setup
cd apps/backend
npx prisma db push
npm run dev  # Backend on :4000

# Frontend setup (in new terminal)
cd apps/frontend
npm run dev  # Frontend on :3000
```

### 3. Configuration Setup

```bash
# Initialize configuration (first time only)
npm run config:init

# Edit configuration with your values
# Update config/base/site.config.ts with:
# - Your domain name
# - Site branding
# - OAuth settings
# - Email addresses

# Validate configuration
npm run config:validate
```

### 4. AWS Deployment
```bash
# Set environment (development or production)
export SEMIONT_ENV=development

# Deploy all stacks (infrastructure + application)  
./scripts/semiont create all

# Or deploy stacks individually:
# ./scripts/semiont create infra  # Infrastructure stack only
# ./scripts/semiont create app    # Application stack only

# Configure OAuth secrets (after deployment)
./scripts/semiont secrets set oauth/google
```

**Note**: AWS credentials are detected automatically using the standard AWS credential chain (AWS CLI configuration, SSO, environment variables, etc.). If you need to configure credentials, run:
- `aws configure` for access keys
- `aws sso login` for AWS SSO

### 5. Verify Deployment
```bash
# Check system status
./scripts/semiont status

# View logs
./scripts/semiont logs follow

# Get application URLs
./scripts/semiont info
```

## 📖 Documentation

### Development Guides

| Document | Description |
|----------|-------------|
| [Frontend README](apps/frontend/README.md) | Next.js development guide, patterns, and API integration |
| [Frontend Performance](apps/frontend/docs/PERFORMANCE.md) | Frontend performance optimization guide |
| [Backend README](apps/backend/README.md) | Hono API development guide, type safety, and database patterns |
| [Scripts README](scripts/README.md) | Management scripts architecture, security features, and usage |
| [Config README](config/README.md) | Configuration system architecture and environment management |
| [CDK README](cdk/README.md) | Infrastructure as Code setup and deployment |

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

Semiont uses a unified TypeScript-based configuration system that provides:
- **Type Safety**: All configuration validated at compile time
- **Environment Management**: Separate configs for development/production
- **Centralized Settings**: Domain, OAuth, AWS resources all configured in one place
- **Secure Secrets**: Local secrets managed via `semiont secrets` command (not in files)

Both frontend and backend read from the same `config/` directory:
- **Configuration**: Stored in `config/base/site.config.ts` (domain, branding, OAuth)
- **Secrets**: Managed via `semiont secrets` command for local development
- **Production**: Secrets automatically injected from AWS Secrets Manager

No more `.env` files - everything is type-safe and centralized!

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
Start with the [Scripts README](scripts/README.md) to understand:
- Management CLI architecture and security features
- AWS resource management and monitoring
- Deployment automation and health checks
- Performance analysis and cost optimization

### Key Development Principles

1. **Type Safety First**: Full TypeScript coverage from database to UI
2. **Security by Default**: Input validation, command injection prevention, sensitive data redaction
3. **Performance Optimized**: Bundle analysis, Lighthouse CI, performance monitoring
4. **Error Resilience**: Comprehensive error boundaries and graceful degradation
5. **Developer Experience**: Auto-completion, inline documentation, hot reloading

## 🧪 Testing

The project uses modern testing frameworks with intelligent test type filtering:

- **Frontend**: Vitest + MSW v2 + React Testing Library (1012 tests organized by type)
- **Backend**: Vitest with comprehensive coverage (176+ tests organized by type)
- **Both**: Strict TypeScript compilation catches errors at build time

### Test Type Organization

Semiont organizes tests into four distinct categories for targeted testing:

- **🧩 Unit Tests**: Individual components, functions, hooks (~1007 frontend, ~176 backend)
- **🔗 Integration Tests**: Multi-component workflows and user flows (~5 frontend, ~41 backend)
- **🌐 API Tests**: Endpoint validation and route handlers (~77 frontend, ~60 backend)
- **🔒 Security Tests**: Authentication, validation, GDPR compliance (~5 across both apps)

### Running Tests

#### Using Semiont CLI (Recommended)

```bash
# Run all tests with coverage (default)
./scripts/semiont test

# Run by application
./scripts/semiont test frontend           # Frontend only
./scripts/semiont test backend            # Backend only
./scripts/semiont test all                # Both apps (default)

# Run by test type  
./scripts/semiont test unit               # Unit tests only
./scripts/semiont test integration        # Integration tests only
./scripts/semiont test api               # API/route tests only
./scripts/semiont test security          # Security tests only

# Combine application and test type
./scripts/semiont test frontend unit     # Frontend unit tests
./scripts/semiont test backend api       # Backend API tests

# Additional options
./scripts/semiont test --no-coverage     # Skip coverage for speed
./scripts/semiont test frontend --watch  # Watch mode
./scripts/semiont test --verbose         # Detailed output
```

#### Direct npm Scripts

```bash
# Run all tests
npm test  # From root directory

# Frontend tests (apps/frontend/)
npm test                    # All tests
npm run test:unit          # Unit tests only  
npm run test:integration   # Integration tests only
npm run test:api           # API route tests only
npm run test:security      # Security tests only
npm run test:coverage      # All tests with coverage
npm run test:watch         # Watch mode

# Backend tests (apps/backend/)
npm test                    # All tests
npm run test:unit          # Unit tests only
npm run test:integration   # Integration tests only
npm run test:api           # API tests only
npm run test:security      # Security tests only
npm run test:coverage      # All tests with coverage
npm run test:watch         # Watch mode
```

#### Performance Benefits

Targeted test execution provides significant performance improvements:
- **Unit tests**: Excludes integration tests for faster feedback
- **Integration tests**: Only 5-41 tests vs full suite for complex workflow testing
- **API tests**: Focuses on endpoints without UI component overhead
- **Security tests**: Runs only security-critical validations

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