#!/bin/bash

# Enhanced error handling and verbose output
set -euo pipefail

# Enable verbose logging
echo "=========================================="
echo "SEMIONT DEVCONTAINER POST-CREATE SCRIPT"
echo "=========================================="
echo "Starting at: $(date)"
echo "Working directory: $(pwd)"
echo "User: $(whoami)"
echo "Environment variables:"
echo "  SEMIONT_ENV=${SEMIONT_ENV:-not set}"
echo "  SEMIONT_ROOT=${SEMIONT_ROOT:-not set}"
echo "  SEMIONT_REPO=${SEMIONT_REPO:-not set}"
echo "  CODESPACES=${CODESPACES:-not set}"
echo "  REMOTE_CONTAINERS=${REMOTE_CONTAINERS:-not set}"
echo "------------------------------------------"

# Colors for output (but also echo without colors for logs)
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to print colored output with timestamps
print_status() {
    local msg="[$(date '+%H:%M:%S')] STATUS: $1"
    echo "$msg"
    echo -e "${BLUE}==>${NC} $1"
}

print_success() {
    local msg="[$(date '+%H:%M:%S')] SUCCESS: $1"
    echo "$msg"
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    local msg="[$(date '+%H:%M:%S')] WARNING: $1"
    echo "$msg"
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    local msg="[$(date '+%H:%M:%S')] ERROR: $1"
    echo "$msg"
    echo -e "${RED}✗${NC} $1" >&2
}

# Error handler
error_handler() {
    local line_no=$1
    local exit_code=$2
    print_error "Script failed at line $line_no with exit code $exit_code"
    print_error "Last command: ${BASH_COMMAND}"
    echo "=========================================="
    echo "POST-CREATE SCRIPT FAILED"
    echo "=========================================="
    exit $exit_code
}

trap 'error_handler ${LINENO} $?' ERR

# Set environment variables
print_status "Setting environment variables..."
export SEMIONT_ENV=local
export SEMIONT_ROOT=/workspace
export SEMIONT_REPO=/workspace
echo "  SEMIONT_ENV=$SEMIONT_ENV"
echo "  SEMIONT_ROOT=$SEMIONT_ROOT"
echo "  SEMIONT_REPO=$SEMIONT_REPO"
print_success "Environment variables set"

# Check Node.js and npm versions
print_status "Checking Node.js and npm versions..."
echo "  Node.js version: $(node --version)"
echo "  npm version: $(npm --version)"
print_success "Node.js and npm are available"

# Install dependencies
print_status "Installing npm dependencies (this may take a few minutes)..."
echo "Running: npm install"
if npm install; then
    print_success "Dependencies installed successfully"
else
    print_error "npm install failed"
    exit 1
fi

# Build all packages including CLI
print_status "Building packages and CLI (this may take a few minutes)..."
echo "Running: npm run build"
if npm run build; then
    print_success "Packages built successfully"
else
    print_error "npm run build failed"
    exit 1
fi

# Install the Semiont CLI globally
print_status "Installing Semiont CLI globally..."
echo "Changing to CLI directory: /workspace/apps/cli"
cd /workspace/apps/cli || {
    print_error "Failed to change to CLI directory"
    exit 1
}

echo "Running: npm link"
if npm link; then
    print_success "Semiont CLI linked successfully"
else
    print_error "npm link failed"
    exit 1
fi

echo "Returning to workspace root"
cd /workspace || {
    print_error "Failed to return to workspace root"
    exit 1
}

# Verify CLI is available
print_status "Verifying Semiont CLI installation..."
if command -v semiont &> /dev/null; then
    echo "  Semiont CLI path: $(which semiont)"
    echo "  Semiont CLI version: $(semiont --version 2>/dev/null || echo 'version command failed')"
    print_success "Semiont CLI is available"
else
    print_warning "Semiont CLI not found in PATH, continuing anyway"
fi

# Initialize Semiont project
print_status "Checking for Semiont project initialization..."
if [ ! -f "semiont.json" ]; then
    print_status "Initializing new Semiont project..."
    echo "Running: semiont init --name 'semiont-dev' --environments 'local,staging,production'"
    if semiont init --name "semiont-dev" --environments "local,staging,production"; then
        print_success "Semiont project initialized"
    else
        print_warning "Semiont init failed, continuing with manual setup"
    fi
else
    print_success "Semiont project already initialized (semiont.json exists)"
fi

# Wait for PostgreSQL to be ready before provisioning
print_status "Waiting for PostgreSQL to be ready..."
max_attempts=30
attempt=0
while ! pg_isready -h localhost -p 5432 -U semiont > /dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ $attempt -ge $max_attempts ]; then
        print_warning "PostgreSQL not ready after ${max_attempts} attempts, continuing anyway"
        break
    fi
    echo "  Attempt $attempt/$max_attempts - PostgreSQL not ready, waiting..."
    sleep 2
done

if [ $attempt -lt $max_attempts ]; then
    print_success "PostgreSQL is ready"
fi

# Create environment configuration for local
print_status "Setting up environment configuration..."
if [ ! -f "environments/local.json" ]; then
    print_status "Creating environments/local.json..."
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
    print_success "Environment configuration already exists"
fi

# Provision backend service (database setup, migrations, etc.)
print_status "Provisioning backend service..."
echo "Running: semiont provision --service backend --skip-build"
if semiont provision --service backend --skip-build 2>&1; then
    print_success "Backend provisioned successfully"
else
    print_warning "Backend provisioning via CLI failed, attempting manual setup..."

    # Fallback to manual database setup if CLI fails
    cd apps/backend || {
        print_error "Failed to change to backend directory"
        exit 1
    }

    echo "Running: npm run prisma:generate"
    if npm run prisma:generate; then
        print_success "Prisma client generated"
    else
        print_warning "Prisma generate failed"
    fi

    echo "Running: npx prisma db push"
    if npx prisma db push; then
        print_success "Database schema pushed"
    else
        print_warning "Database push failed"
    fi

    cd /workspace || {
        print_error "Failed to return to workspace root"
        exit 1
    }
fi

# Provision frontend service (env setup, etc.)
print_status "Provisioning frontend service..."
echo "Running: semiont provision --service frontend --skip-build"
if semiont provision --service frontend --skip-build 2>&1; then
    print_success "Frontend provisioned successfully"
else
    print_warning "Frontend provisioning failed, continuing with manual setup"
fi

# Create convenience .env files for direct npm usage (as fallback)
print_status "Creating convenience .env files..."

# Backend .env
print_status "Creating backend .env file..."
cd /workspace/apps/backend || {
    print_error "Failed to change to backend directory"
    exit 1
}

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
else
    print_success "Backend .env already exists"
fi

# Frontend .env.local
print_status "Creating frontend .env.local file..."
cd /workspace/apps/frontend || {
    print_error "Failed to change to frontend directory"
    exit 1
}

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
else
    print_success "Frontend .env.local already exists"
fi

# Demo .env
print_status "Creating demo .env file..."
cd /workspace/demo || {
    print_error "Failed to change to demo directory"
    exit 1
}

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
else
    print_success "Demo .env already exists"
fi

cd /workspace || {
    print_error "Failed to return to workspace root"
    exit 1
}

# Create a welcome message
echo ""
echo ""
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
print_status "Checking for required secrets..."

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    print_warning "ANTHROPIC_API_KEY is not set. AI features will not work."
    echo "  Configure it in: Settings > Codespaces > Secrets"
else
    print_success "ANTHROPIC_API_KEY is configured"
fi

if [ -z "${NEO4J_URI:-}" ] || [ -z "${NEO4J_USERNAME:-}" ] || [ -z "${NEO4J_PASSWORD:-}" ]; then
    print_warning "Neo4j credentials are not configured. Graph features will not work."
    echo "  Configure them in: Settings > Codespaces > Secrets"
else
    print_success "Neo4j credentials are configured"
fi

# Configure VS Code IDE state for better user experience
if [ -n "${CODESPACES:-}" ] || [ -n "${REMOTE_CONTAINERS:-}" ]; then
    print_status "Configuring IDE workspace..."

    # Check if code command is available
    if command -v code &> /dev/null; then
        echo "VS Code CLI is available"

        # Close any auto-opened panels (like Copilot chat)
        echo "Closing auxiliary panels..."
        code --command "workbench.action.closeAuxiliaryBar" 2>/dev/null || true
        code --command "github.copilot.interactiveEditor.close" 2>/dev/null || true

        # Open the file explorer view (sidebar)
        echo "Opening file explorer..."
        code --command "workbench.view.explorer" 2>/dev/null || true

        # Open key README files for user orientation
        echo "Opening README files..."
        code /workspace/README.md 2>/dev/null || true
        code /workspace/demo/README.md 2>/dev/null || true

        print_success "IDE configured with documentation"
    else
        print_warning "VS Code CLI not available, skipping IDE configuration"
    fi
fi

echo ""
echo "=========================================="
echo "POST-CREATE SCRIPT COMPLETED SUCCESSFULLY"
echo "=========================================="
echo "Completed at: $(date)"
echo ""

print_success "Setup complete! Happy coding! 🚀"

# Note: We don't automatically start services here because the user might want to
# choose which services to run. The database is already running via docker-compose.