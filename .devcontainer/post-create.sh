#!/bin/bash

# Enhanced error handling and verbose output
set -euo pipefail

# Force unbuffered output so logs appear immediately
exec 2>&1
export PYTHONUNBUFFERED=1

# Create a log file that can be tailed
LOG_FILE="/tmp/post-create.log"
echo "Starting post-create setup at $(date)" | tee $LOG_FILE

# Function to log with immediate output
log_output() {
    echo "$1" | tee -a $LOG_FILE
    # Force flush
    sync
}

# Enable verbose logging
echo "=========================================="
echo "SEMIONT DEVCONTAINER POST-CREATE SCRIPT"
echo "=========================================="
echo "Starting at: $(date)"
echo ""
echo "⚠️  IMPORTANT: This setup takes 5-7 minutes."
echo ""

# Try to open the Creation Log automatically (may not work in all contexts)
if command -v code &> /dev/null; then
    echo "Attempting to open Creation Log..."
    # Try to open the output panel
    code --command "workbench.action.output.toggleOutput" 2>/dev/null || true
    # Try to focus on Codespaces log
    code --command "workbench.action.showLogs" 2>/dev/null || true
    # Try the specific creation log command
    code --command "codespaces.viewCreationLog" 2>/dev/null || true
fi

echo "The terminal will show a spinner during setup."
echo "To see real-time progress:"
echo ""
echo "  1. Press Cmd/Ctrl + Shift + P"
echo "  2. Type: View Creation Log"
echo "  3. Select: Codespaces: View Creation Log"
echo ""
echo "Or check the log file after setup:"
echo "  cat /tmp/post-create.log"
echo ""
echo "Setup steps:"
echo "  1. Install npm dependencies (2-4 minutes)"
echo "  2. Build all packages and CLI (1-2 minutes)"
echo "  3. Configure Semiont CLI"
echo "  4. Set up database schema"
echo "  5. Create environment files"
echo "  6. Configure IDE workspace"
echo ""
echo "Environment variables:"
echo "  SEMIONT_ENV=${SEMIONT_ENV:-not set} (should be 'local')"
echo "  SEMIONT_ROOT=${SEMIONT_ROOT:-not set} (should be '/workspace/project')"
echo "  SEMIONT_REPO=${SEMIONT_REPO:-not set} (should be '/workspace')"
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

# Verify environment variables are set
print_status "Verifying environment variables..."
echo "  SEMIONT_ENV=$SEMIONT_ENV"
echo "  SEMIONT_ROOT=$SEMIONT_ROOT"
echo "  SEMIONT_REPO=$SEMIONT_REPO"
if [ -z "$SEMIONT_ENV" ] || [ -z "$SEMIONT_ROOT" ] || [ -z "$SEMIONT_REPO" ]; then
    print_error "Required environment variables not set - check devcontainer.json"
    exit 1
fi
print_success "Environment variables verified"

# Check Node.js and npm versions
print_status "Checking Node.js and npm versions..."
echo "  Node.js version: $(node --version)"
echo "  npm version: $(npm --version)"
print_success "Node.js and npm are available"

# Build and install everything
print_status "Installing dependencies and building Semiont..."
cd /workspace || exit 1

echo "Running npm install..."
npm install 2>&1 | tee -a $LOG_FILE || {
    print_error "npm install failed"
    exit 1
}
print_success "Dependencies installed"

echo "Running npm run build..."
npm run build 2>&1 | tee -a $LOG_FILE || {
    print_error "npm run build failed"
    exit 1
}
print_success "Build completed"

echo "Installing Semiont CLI..."
npm run install:cli 2>&1 | tee -a $LOG_FILE || {
    print_error "npm run install:cli failed"
    exit 1
}

# Verify CLI is working
if command -v semiont &> /dev/null; then
    print_success "Semiont CLI installed: $(which semiont)"
    semiont --version --verbose || true
else
    print_error "Semiont CLI installation failed"
    exit 1
fi

print_status "Setting up Semiont project configuration..."

# Create project directory for Semiont workspace
print_status "Creating Semiont project directory..."
mkdir -p /workspace/project
export SEMIONT_ROOT=/workspace/project
print_success "Project directory created at $SEMIONT_ROOT"

# Initialize Semiont project
print_status "Initializing Semiont project..."
cd /workspace || exit 1
semiont init --verbose 2>&1 | tee -a $LOG_FILE || {
    print_warning "Semiont init failed or project already initialized, continuing..."
}

# Wait for PostgreSQL to be ready before provisioning
print_status "Waiting for PostgreSQL to be ready..."
max_attempts=30
attempt=0
echo "Checking PostgreSQL connection (max ${max_attempts} attempts)..."
while ! pg_isready -h localhost -p 5432 -U semiont > /dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ $attempt -ge $max_attempts ]; then
        print_warning "PostgreSQL not ready after ${max_attempts} attempts, continuing anyway"
        break
    fi
    echo -n "."  # Show progress dots
    sleep 2
done
echo ""  # New line after dots

if [ $attempt -lt $max_attempts ]; then
    print_success "PostgreSQL is ready"
fi

# Create semiont.json configuration
print_status "Creating semiont.json configuration..."
if [ ! -f "semiont.json" ]; then
    cat > semiont.json << 'EOF'
{
  "version": "1.0.0",
  "project": "semiont-devcontainer",
  "site": {
    "siteName": "Semiont Development",
    "domain": "localhost:3000",
    "adminEmail": "dev@example.com",
    "oauthAllowedDomains": ["example.com", "gmail.com"]
  },
  "services": {
    "frontend": {
      "framework": "next",
      "port": 3000
    },
    "backend": {
      "framework": "express",
      "port": 4000
    },
    "database": {
      "type": "postgres",
      "port": 5432
    }
  }
}
EOF
    print_success "semiont.json created"
else
    print_success "semiont.json already exists"
fi

# Create environment configuration for local
print_status "Setting up environment configuration..."
if [ ! -f "environments/local.json" ]; then
    print_status "Creating environments/local.json..."
    mkdir -p environments
    cat > environments/local.json << 'EOF'
{
  "name": "local",
  "platform": {
    "default": "container"
  },
  "deployment": {
    "imageTagStrategy": "mutable"
  },
  "site": {
    "domain": "localhost:3000"
  },
  "env": {
    "NODE_ENV": "development"
  },
  "services": {
    "backend": {
      "platform": {
        "type": "posix"
      },
      "command": "npm run dev",
      "port": 4000,
      "publicURL": "http://localhost:4000",
      "corsOrigin": "http://localhost:3000"
    },
    "frontend": {
      "platform": {
        "type": "posix"
      },
      "command": "npm run dev",
      "port": 3000,
      "url": "http://localhost:3000"
    },
    "database": {
      "platform": {
        "type": "container"
      },
      "image": "postgres:16-alpine",
      "name": "semiont-local-db",
      "port": 5432,
      "environment": {
        "POSTGRES_DB": "semiont",
        "POSTGRES_USER": "semiont",
        "POSTGRES_PASSWORD": "semiont"
      }
    },
    "graph": {
      "platform": {
        "type": "external"
      },
      "type": "neo4j",
      "name": "neo4j",
      "uri": "${NEO4J_URI}",
      "username": "${NEO4J_USERNAME}",
      "password": "${NEO4J_PASSWORD}",
      "database": "${NEO4J_DATABASE}"
    },
    "mcp": {
      "platform": {
        "type": "posix"
      },
      "dependsOn": ["backend"]
    },
    "filesystem": {
      "platform": {
        "type": "posix"
      },
      "path": "./data/uploads",
      "description": "Local filesystem storage for uploads and assets"
    },
    "inference": {
      "platform": {
        "type": "external"
      },
      "type": "anthropic",
      "model": "claude-3-5-sonnet-20241022",
      "maxTokens": 8192,
      "endpoint": "https://api.anthropic.com",
      "apiKey": "${ANTHROPIC_API_KEY}"
    }
  }
}
EOF
    print_success "Environment configuration created"
else
    print_success "Environment configuration already exists"
fi

# Provision services individually using Semiont CLI
print_status "Provisioning services with Semiont CLI..."
cd /workspace || {
    print_error "Failed to change to workspace directory"
    exit 1
}

# Provision database service first
echo "Provisioning database service..."
semiont provision --service database --verbose 2>&1 | tee -a $LOG_FILE || {
    print_error "Database provisioning failed"
    exit 1
}
print_success "Database service provisioned"

# Wait for database to be ready after provisioning
sleep 3

# Provision backend service (this creates the proper .env file)
echo "Provisioning backend service..."
semiont provision --service backend --verbose 2>&1 | tee -a $LOG_FILE || {
    print_error "Backend provisioning failed - fix the CLI"
    exit 1
}
print_success "Backend service provisioned with environment variables"

# Provision frontend service (this creates the proper .env.local file)
echo "Provisioning frontend service..."
semiont provision --service frontend --verbose 2>&1 | tee -a $LOG_FILE || {
    print_error "Frontend provisioning failed - fix the CLI"
    exit 1
}
print_success "Frontend service provisioned with environment variables"

# Setup database schema after services are provisioned
print_status "Setting up database schema..."
cd apps/backend || {
    print_error "Failed to change to backend directory"
    exit 1
}

echo "Generating Prisma client..."
if npm run prisma:generate 2>&1 | tee -a $LOG_FILE; then
    print_success "Prisma client generated"
else
    print_warning "Prisma generate failed, continuing anyway"
fi

echo "Pushing database schema..."
if npx prisma db push --skip-generate 2>&1 | tee -a $LOG_FILE; then
    print_success "Database schema pushed"
else
    print_warning "Database push failed, continuing anyway"
fi

cd /workspace || {
    print_error "Failed to return to workspace root"
    exit 1
}

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
      semiont start --verbose             ${GREEN}# Start all services${NC}
      semiont status --verbose            ${GREEN}# Check service status${NC}
      semiont logs                       ${GREEN}# View logs${NC}
      semiont stop --verbose              ${GREEN}# Stop services${NC}

    ${BLUE}Start individual services:${NC}
      semiont start --service backend --verbose    ${GREEN}# Start API server${NC}
      semiont start --service frontend --verbose   ${GREEN}# Start web app${NC}

    ${BLUE}Using npm directly (alternative):${NC}
      cd apps/backend && npm run dev     ${GREEN}# Start API server${NC}
      cd apps/frontend && npm run dev    ${GREEN}# Start web app${NC}

    ${BLUE}Demo Applications:${NC}
      cd demo && npm run demo:interactive ${GREEN}# Run interactive demo${NC}

  📖 Documentation:
    - API Docs: http://localhost:4000/docs
    - README: /workspace/README.md
    - Architecture: /workspace/docs/ARCHITECTURE.md
    - CLI Help: semiont --help

  ⚙️  Configuration:
    - Project root: /workspace/project
    - Repository root: /workspace
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

# Note: IDE configuration (opening files, showing explorer) is handled by
# the postAttachCommand in devcontainer.json for immediate visibility

echo ""
echo "=========================================="
echo "POST-CREATE SCRIPT COMPLETED SUCCESSFULLY"
echo "=========================================="
echo "Completed at: $(date)"
echo ""

print_success "Setup complete! Happy coding! 🚀"

# Move to demo directory and show the command to run
cd /workspace/demo
echo ""
echo "================================"
echo "Ready to run the interactive demo!"
echo "To start: npm run demo:interactive"
echo "================================"

# Configure bash to start in demo directory for new terminals
echo "" >> /home/node/.bashrc
echo "# Start in demo directory for Semiont development" >> /home/node/.bashrc
echo "if [ -d /workspace/demo ]; then" >> /home/node/.bashrc
echo "    cd /workspace/demo" >> /home/node/.bashrc
echo "fi" >> /home/node/.bashrc

# Note: We don't automatically start services here because the user might want to
# choose which services to run. The database is already running via docker-compose.