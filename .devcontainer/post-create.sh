#!/bin/bash
set -e

echo "🚀 Setting up Semiont development environment..."

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}==>${NC} $1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# Set environment variables
export SEMIONT_ENV=local
export SEMIONT_ROOT=/workspace
export SEMIONT_REPO=/workspace

# Install dependencies
print_status "Installing npm dependencies..."
npm install
print_success "Dependencies installed"

# Build all packages including CLI
print_status "Building packages and CLI..."
npm run build
print_success "Packages built"

# Install the Semiont CLI globally
print_status "Installing Semiont CLI globally..."
cd /workspace/apps/cli
npm link
cd /workspace
print_success "Semiont CLI installed"

# Initialize Semiont project
print_status "Initializing Semiont project..."
if [ ! -f "semiont.json" ]; then
    semiont init --name "semiont-dev" --environments "local,staging,production"
    print_success "Semiont project initialized"
else
    print_warning "Semiont project already initialized, skipping"
fi

# Wait for PostgreSQL to be ready before provisioning
print_status "Waiting for PostgreSQL to be ready..."
while ! pg_isready -h localhost -p 5432 -U semiont > /dev/null 2>&1; do
    sleep 1
done
print_success "PostgreSQL is ready"

# Create environment configuration for local
print_status "Setting up environment configuration..."
if [ ! -f "environments/local.json" ]; then
    mkdir -p environments
    cat > environments/local.json << 'EOF'
{
  "name": "local",
  "type": "development",
  "services": {
    "database": {
      "platform": "container",
      "config": {
        "image": "postgres:16-alpine",
        "name": "semiont-postgres",
        "env": {
          "POSTGRES_USER": "semiont",
          "POSTGRES_PASSWORD": "semiont",
          "POSTGRES_DB": "semiont"
        },
        "ports": {
          "5432": "5432"
        }
      }
    },
    "backend": {
      "platform": "posix",
      "config": {
        "dir": "apps/backend",
        "env": {
          "DATABASE_URL": "postgresql://semiont:semiont@localhost:5432/semiont?schema=public",
          "PORT": "4000",
          "JWT_SECRET": "dev-secret-change-in-production",
          "JWT_ISSUER": "semiont-dev",
          "JWT_AUDIENCE": "semiont-dev",
          "NODE_ENV": "development",
          "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}",
          "NEO4J_URI": "${NEO4J_URI}",
          "NEO4J_USERNAME": "${NEO4J_USERNAME}",
          "NEO4J_PASSWORD": "${NEO4J_PASSWORD}",
          "NEO4J_DATABASE": "${NEO4J_DATABASE}"
        }
      }
    },
    "frontend": {
      "platform": "posix",
      "config": {
        "dir": "apps/frontend",
        "env": {
          "NEXT_PUBLIC_API_BASE_URL": "http://localhost:4000",
          "NEXT_PUBLIC_API_VERSION": "v1",
          "NODE_ENV": "development",
          "PORT": "3000"
        }
      }
    }
  }
}
EOF
    print_success "Environment configuration created"
else
    print_warning "Environment configuration already exists"
fi

# Provision backend service (database setup, migrations, etc.)
print_status "Provisioning backend service..."
semiont provision --service backend --skip-build || {
    print_warning "Backend provisioning failed, attempting manual setup..."

    # Fallback to manual database setup if CLI fails
    cd apps/backend
    npm run prisma:generate
    npx prisma db push
    cd /workspace
}
print_success "Backend provisioned"

# Provision frontend service (env setup, etc.)
print_status "Provisioning frontend service..."
semiont provision --service frontend --skip-build || {
    print_warning "Frontend provisioning failed, continuing..."
}
print_success "Frontend provisioned"

# Create convenience .env files for direct npm usage (as fallback)
print_status "Creating convenience .env files..."

# Backend .env
cd /workspace/apps/backend
if [ ! -f .env ]; then
    cat > .env << EOF
# Database
DATABASE_URL="postgresql://semiont:semiont@localhost:5432/semiont?schema=public"

# Authentication
JWT_SECRET="dev-secret-change-in-production"
JWT_ISSUER="semiont-dev"
JWT_AUDIENCE="semiont-dev"

# Server
PORT=4000
NODE_ENV=development

# AI Services (from Codespaces secrets)
ANTHROPIC_API_KEY=\${ANTHROPIC_API_KEY}

# Neo4j (from Codespaces secrets)
NEO4J_URI=\${NEO4J_URI}
NEO4J_USERNAME=\${NEO4J_USERNAME}
NEO4J_PASSWORD=\${NEO4J_PASSWORD}
NEO4J_DATABASE=\${NEO4J_DATABASE}
EOF
    print_success "Backend .env created"
fi

# Frontend .env.local
cd /workspace/apps/frontend
if [ ! -f .env.local ]; then
    cat > .env.local << EOF
# API Configuration
NEXT_PUBLIC_API_BASE_URL="http://localhost:4000"
NEXT_PUBLIC_API_VERSION="v1"

# Development
NODE_ENV=development
PORT=3000
EOF
    print_success "Frontend .env.local created"
fi

# Demo .env
cd /workspace/demo
if [ ! -f .env ]; then
    cat > .env << EOF
# Semiont API
SEMIONT_API_URL="http://localhost:4000"
SEMIONT_USER_EMAIL="demo@example.com"
SEMIONT_USER_PASSWORD="123456"

# AI Services (from Codespaces secrets)
ANTHROPIC_API_KEY=\${ANTHROPIC_API_KEY}
EOF
    print_success "Demo .env created"
fi

cd /workspace

# Create a welcome message
cat << EOF

${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}

    ${BLUE}🎉 Semiont Development Environment Ready!${NC}

${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}

  📚 Quick Start Commands:

    ${BLUE}Using Semiont CLI (Recommended):${NC}
      semiont start --service backend    ${GREEN}# Start API server${NC}
      semiont start --service frontend   ${GREEN}# Start web app${NC}
      semiont start                      ${GREEN}# Start all services${NC}
      semiont status                     ${GREEN}# Check service status${NC}
      semiont logs --service backend     ${GREEN}# View backend logs${NC}

    ${BLUE}Using npm directly:${NC}
      cd apps/backend && npm run dev     ${GREEN}# Start API server${NC}
      cd apps/frontend && npm run dev    ${GREEN}# Start web app${NC}
      npm run dev                        ${GREEN}# Start both${NC}

    ${BLUE}Demo:${NC}
      cd demo && npm run pro-bo           ${GREEN}# Run Prometheus Bound demo${NC}

  📖 Documentation:
    - API Docs: http://localhost:4000/docs
    - README: /workspace/README.md
    - Architecture: /workspace/docs/ARCHITECTURE.md
    - CLI Help: semiont --help

  ⚙️  Configuration:
    - Project config: /workspace/semiont.json
    - Environment: /workspace/environments/local.json
    - Backend env: /workspace/apps/backend/.env
    - Frontend env: /workspace/apps/frontend/.env.local

  🔑 Required Secrets (configure in GitHub Codespaces settings):
    ${YELLOW}• ANTHROPIC_API_KEY${NC} - For AI features
    ${YELLOW}• NEO4J_URI${NC} - Neo4j connection string
    ${YELLOW}• NEO4J_USERNAME${NC} - Neo4j username
    ${YELLOW}• NEO4J_PASSWORD${NC} - Neo4j password
    ${YELLOW}• NEO4J_DATABASE${NC} - Neo4j database name

${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}

EOF

# Check if required secrets are set
if [ -z "$ANTHROPIC_API_KEY" ]; then
    print_warning "ANTHROPIC_API_KEY is not set. AI features will not work."
    print_warning "Configure it in: Settings > Codespaces > Secrets"
fi

if [ -z "$NEO4J_URI" ] || [ -z "$NEO4J_USERNAME" ] || [ -z "$NEO4J_PASSWORD" ]; then
    print_warning "Neo4j credentials are not configured. Graph features will not work."
    print_warning "Configure them in: Settings > Codespaces > Secrets"
fi

print_success "Setup complete! Happy coding! 🚀"

# Note: We don't automatically start services here because the user might want to
# choose which services to run. The database is already running via docker-compose.