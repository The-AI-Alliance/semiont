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
│   ├── lib/
│   │   ├── infra-stack.ts # Infrastructure stack (VPC, RDS, EFS)
│   │   └── app-stack.ts   # Application stack (ECS, ALB, CloudFront)
│   └── bin/cdk.ts        # CDK entry point
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
cp .env.example .env.local
npm run dev:mock  # Frontend on :3000 with mock API
```

#### Full Stack Development
```bash
# Start PostgreSQL (Docker)
docker run --name semiont-postgres \
  -e POSTGRES_PASSWORD=localpassword \
  -e POSTGRES_DB=semiont \
  -p 5432:5432 \
  -d postgres:15-alpine

# Backend setup
cd apps/backend
cp .env.example .env
# Edit .env with DATABASE_URL="postgresql://postgres:localpassword@localhost:5432/semiont"
npx prisma db push
npm run dev  # Backend on :4000

# Frontend setup (in new terminal)
cd apps/frontend
cp .env.example .env.local
npm run dev  # Frontend on :3000
```

### 3. AWS Deployment
```bash
# Configure AWS credentials
export AWS_PROFILE=your-profile  # or use AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY

# Bootstrap CDK (first time only)
cd cdk
npm run cdk bootstrap

# Deploy infrastructure stack
npm run cdk deploy SemiontInfraStack

# Deploy application stack  
npm run cdk deploy SemiontAppStack

# Configure OAuth (after deployment)
../scripts/semiont secrets set oauth/google
```

### 4. Verify Deployment
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

The project uses modern testing frameworks tailored for each application:

- **Frontend**: Vitest + MSW v2 + React Testing Library (100% test success rate, 244 tests)
- **Backend**: Jest with comprehensive integration tests (40.6% coverage)
- **Both**: Strict TypeScript compilation catches errors at build time

### Frontend Testing Stack
- **Vitest** - Fast, ESM-native test runner
- **MSW v2** - Network-level API mocking
- **React Testing Library** - User-focused component testing

### Running Tests

```bash
# Run all tests
npm test  # From root directory

# Frontend tests (Vitest)
cd apps/frontend
npm test              # Run once
npm run test:watch    # Watch mode
npm run test:coverage # With coverage

# Backend tests (Jest)
cd apps/backend
npm test              # Run once
npm run test:watch    # Watch mode
npm run test:coverage # With coverage
```

See [Testing Documentation](./docs/TESTING.md) and app-specific READMEs for detailed testing strategies.

## 📜 License

Apache 2.0 - See [LICENSE](LICENSE) for details.