# Semiont Development Container

This directory contains the configuration for GitHub Codespaces and VS Code Dev Containers, providing a fully configured development environment for Semiont.

## 🚀 Quick Start

### GitHub Codespaces (Recommended)

1. **Launch Codespace**: Click the button below or go to the repository and click "Code" → "Codespaces" → "Create codespace on main"

   [![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://github.com/codespaces/new/The-AI-Alliance/semiont)

2. **Configure Secrets**: Before launching, configure these secrets in your GitHub settings ([Settings → Codespaces → Secrets](https://github.com/settings/codespaces)):

   - `ANTHROPIC_API_KEY` - Your Anthropic API key for AI features
   - `NEO4J_URI` - Neo4j connection URI (e.g., `neo4j+s://xxxxx.databases.neo4j.io`)
   - `NEO4J_USERNAME` - Neo4j username (usually `neo4j`)
   - `NEO4J_PASSWORD` - Neo4j password
   - `NEO4J_DATABASE` - Neo4j database name (usually `neo4j`)

3. **Start Development**: Once the Codespace is ready, run:

   ```bash
   npm run dev  # Starts both frontend and backend
   ```

### VS Code Dev Containers (Local)

1. **Prerequisites**:
   - Docker Desktop installed and running
   - VS Code with the "Dev Containers" extension

2. **Environment Variables**: Create a `.env` file in the `.devcontainer` directory:

   ```bash
   ANTHROPIC_API_KEY=your-api-key
   NEO4J_URI=neo4j+s://xxxxx.databases.neo4j.io
   NEO4J_USERNAME=neo4j
   NEO4J_PASSWORD=your-password
   NEO4J_DATABASE=neo4j
   ```

3. **Open in Container**:
   - Open the repository in VS Code
   - Press `F1` and select "Dev Containers: Reopen in Container"
   - Wait for the container to build and initialize

## 📦 What's Included

### Services

- **PostgreSQL 16**: Local database for development
- **Node.js 22**: Latest LTS version
- **Docker-in-Docker**: For running containers inside the dev container

### Tools & Features

- **AWS CLI**: For cloud deployments
- **GitHub CLI**: For repository operations
- **Git**: Version control
- **PostgreSQL Client**: Database management tools

### VS Code Extensions

- **Code Quality**:
  - ESLint
  - Prettier
  - Error Lens
  - Pretty TypeScript Errors

- **Productivity**:
  - GitHub Copilot & Copilot Chat
  - Path Intellisense
  - NPM Intellisense
  - Auto Rename Tag

- **Framework Support**:
  - Prisma
  - Tailwind CSS
  - Docker

### Pre-configured Environment

The container automatically:

1. Installs all npm dependencies
2. Builds all packages including the Semiont CLI
3. Installs the Semiont CLI globally (`npm link`)
4. Sets environment variables (`SEMIONT_ENV=local`, `SEMIONT_ROOT=/workspace`)
5. Runs `semiont init` to create project configuration
6. Runs `semiont provision --service backend` to set up database schema
7. Runs `semiont provision --service frontend` to configure frontend
8. Creates `.env` files with proper defaults (as fallback)
9. Configures ports for frontend (3000) and backend (4000)

## 🔧 Configuration

### Ports

- **3000**: Frontend (Next.js)
- **4000**: Backend API (Hono)
- **5432**: PostgreSQL database

### Environment Files Created

- `/workspace/apps/backend/.env` - Backend configuration
- `/workspace/apps/frontend/.env.local` - Frontend configuration
- `/workspace/demo/.env` - Demo scripts configuration

### Database

A local PostgreSQL instance is automatically configured with:

- Username: `semiont`
- Password: `semiont`
- Database: `semiont`
- Connection: `postgresql://semiont:semiont@localhost:5432/semiont`

## 🔑 Secrets Configuration

### For GitHub Codespaces

1. Go to [GitHub Settings → Codespaces → Secrets](https://github.com/settings/codespaces)
2. Add the following repository or user secrets:

| Secret Name | Description | How to Get |
|------------|-------------|------------|
| `ANTHROPIC_API_KEY` | Anthropic Claude API key | [Anthropic Console](https://console.anthropic.com/settings/keys) |
| `NEO4J_URI` | Neo4j database URI | [Neo4j Aura Console](https://console.neo4j.io) |
| `NEO4J_USERNAME` | Neo4j username | Usually `neo4j` |
| `NEO4J_PASSWORD` | Neo4j password | Set during database creation |
| `NEO4J_DATABASE` | Neo4j database name | Usually `neo4j` |

### For Local Dev Containers

Create `.devcontainer/.env` with your secrets (this file is gitignored):

```bash
ANTHROPIC_API_KEY=sk-ant-xxxxx
NEO4J_URI=neo4j+s://xxxxx.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your-password
NEO4J_DATABASE=neo4j
```

## 📝 Common Commands

```bash
# Start development servers
npm run dev                    # Start both frontend and backend
cd apps/frontend && npm run dev  # Frontend only
cd apps/backend && npm run dev   # Backend only

# Database operations
cd apps/backend
npm run db:generate           # Generate Prisma client
npm run db:push              # Push schema to database
npm run db:studio            # Open Prisma Studio

# Testing
npm run test                 # Run all tests
npm run test:watch          # Run tests in watch mode

# Building
npm run build               # Build all packages
npm run typecheck          # Type check all packages

# Demo
cd demo && npm run pro-bo   # Run Prometheus Bound demo
```

## 🐛 Troubleshooting

### Codespace is slow

- Upgrade to a larger machine type in Codespace settings
- Use 4-core or 8-core machines for better performance

### Secrets not working

- Verify secrets are configured in GitHub settings
- Restart the Codespace after adding secrets
- Check the post-create script output for warnings

### Database connection issues

- Ensure PostgreSQL container is running: `docker ps`
- Check database logs: `docker logs semiont-devcontainer-db-1`
- Verify DATABASE_URL in `.env` files

### Port already in use

- Stop any local services using ports 3000, 4000, or 5432
- Or modify port mappings in `docker-compose.yml`

## 📚 Resources

- [GitHub Codespaces Documentation](https://docs.github.com/en/codespaces)
- [VS Code Dev Containers](https://code.visualstudio.com/docs/devcontainers/containers)
- [Semiont Documentation](/workspace/README.md)
- [API Documentation](http://localhost:4000/docs) (when backend is running)
