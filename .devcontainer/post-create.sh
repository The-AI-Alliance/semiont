#!/bin/bash

# Enhanced error handling
set -euo pipefail

# Force unbuffered output so logs appear immediately
exec 2>&1
export PYTHONUNBUFFERED=1

# Create a log file for debugging if needed
LOG_FILE="/tmp/post-create.log"
echo "Starting post-create setup at $(date)" > $LOG_FILE

# Clear the screen for clean output
clear

echo "=========================================="
echo "   SEMIONT DEVCONTAINER SETUP"
echo "=========================================="
echo ""
echo "📋 Setup Steps:"
echo "  • Install dependencies"
echo "  • Build packages & CLI"
echo "  • Configure Semiont"
echo "  • Initialize database"
echo "  • Start services"
echo ""
echo "⏱️  Estimated time: 5-7 minutes"
echo "------------------------------------------"
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to print colored output with timestamps
print_status() {
    echo -e "\n${BLUE}▶${NC} $1"
    echo "[$(date '+%H:%M:%S')] STATUS: $1" >> $LOG_FILE
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
    echo "[$(date '+%H:%M:%S')] SUCCESS: $1" >> $LOG_FILE
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
    echo "[$(date '+%H:%M:%S')] WARNING: $1" >> $LOG_FILE
}

print_error() {
    echo -e "${RED}✗${NC} $1" >&2
    echo "[$(date '+%H:%M:%S')] ERROR: $1" >> $LOG_FILE
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
print_status "Checking environment..."
if [ -z "$SEMIONT_ENV" ] || [ -z "$SEMIONT_ROOT" ] || [ -z "$SEMIONT_REPO" ]; then
    print_error "Required environment variables not set"
    echo "  SEMIONT_ENV=${SEMIONT_ENV:-not set}"
    echo "  SEMIONT_ROOT=${SEMIONT_ROOT:-not set}"
    echo "  SEMIONT_REPO=${SEMIONT_REPO:-not set}"
    exit 1
fi
print_success "Environment ready"

# Check Node.js and npm versions
print_status "Checking tools..."
print_success "Node $(node --version), npm $(npm --version)"

# Build and install everything
cd /workspace || exit 1

print_status "Installing dependencies (this takes 2-4 minutes)..."
npm install >> $LOG_FILE 2>&1 || {
    print_error "npm install failed - check $LOG_FILE for details"
    exit 1
}
print_success "Dependencies installed"

print_status "Building packages..."
npm run build >> $LOG_FILE 2>&1 || {
    print_error "npm run build failed - check $LOG_FILE for details"
    exit 1
}
print_success "Build completed"

print_status "Building Semiont CLI..."

# First build the MCP server package
npm run build -w @semiont/mcp-server >> $LOG_FILE 2>&1 || {
    print_error "MCP server build failed - check $LOG_FILE for details"
    exit 1
}

# Then build and link the CLI
cd apps/cli || {
    print_error "Failed to change to CLI directory"
    exit 1
}
npm run build >> $LOG_FILE 2>&1 || {
    print_error "CLI build failed - check $LOG_FILE for details"
    exit 1
}

npm link >> $LOG_FILE 2>&1 || {
    print_error "npm link failed - check $LOG_FILE for details"
    exit 1
}

# Return to workspace root
cd /workspace || exit 1

# Get npm global bin directory
NPM_GLOBAL_BIN=$(npm bin -g)
echo "npm global bin directory: $NPM_GLOBAL_BIN"

# Add npm global bin to PATH for current session
export PATH="$NPM_GLOBAL_BIN:$PATH"

# Persist PATH configuration for all terminal sessions
echo "Configuring PATH for all terminal sessions..."
echo "" >> /home/node/.bashrc
echo "# Semiont CLI configuration" >> /home/node/.bashrc
echo "export PATH=\"$NPM_GLOBAL_BIN:\$PATH\"" >> /home/node/.bashrc

# Also add to .profile for non-bash shells
echo "" >> /home/node/.profile
echo "# Semiont CLI configuration" >> /home/node/.profile
echo "export PATH=\"$NPM_GLOBAL_BIN:\$PATH\"" >> /home/node/.profile

# Verify CLI is working
if command -v semiont &> /dev/null; then
    SEMIONT_VERSION=$(semiont --version 2>&1 | head -n 1)
    print_success "Semiont CLI installed: $SEMIONT_VERSION"
else
    print_error "Semiont CLI installation failed - not found in PATH"
    echo "  PATH: $PATH" >> $LOG_FILE
    echo "  NPM global bin: $NPM_GLOBAL_BIN" >> $LOG_FILE
    exit 1
fi

# Create project directory for Semiont workspace
mkdir -p /workspace/project
export SEMIONT_ROOT=/workspace/project

# Initialize Semiont project
print_status "Initializing Semiont project..."
cd $SEMIONT_ROOT || exit 1
semiont init >> $LOG_FILE 2>&1 || {
    print_warning "Project already initialized or init failed - continuing"
}
print_success "Project initialized"

# Wait for PostgreSQL to be ready before provisioning
print_status "Waiting for PostgreSQL..."
max_attempts=30
attempt=0
while ! pg_isready -h localhost -p 5432 -U semiont > /dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ $attempt -ge $max_attempts ]; then
        print_warning "PostgreSQL not ready - continuing anyway"
        break
    fi
    echo -n "."
    sleep 2
done
echo ""

if [ $attempt -lt $max_attempts ]; then
    print_success "PostgreSQL ready"
fi

# Create semiont.json configuration in SEMIONT_ROOT
print_status "Creating semiont.json configuration..."
cd $SEMIONT_ROOT || exit 1
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
print_status "Provisioning services..."
cd $SEMIONT_ROOT || {
    print_error "Failed to change to SEMIONT_ROOT directory"
    exit 1
}

# Provision database service first
semiont provision --service database >> $LOG_FILE 2>&1 || {
    print_error "Database provisioning failed - check $LOG_FILE"
    exit 1
}
print_success "Database provisioned"

# Wait for database to be ready after provisioning
sleep 3

# Provision backend service (this creates the proper .env file)
semiont provision --service backend >> $LOG_FILE 2>&1 || {
    print_error "Backend provisioning failed - check $LOG_FILE"
    exit 1
}
print_success "Backend provisioned"

# Provision frontend service (this creates the proper .env.local file)
semiont provision --service frontend >> $LOG_FILE 2>&1 || {
    print_error "Frontend provisioning failed - check $LOG_FILE"
    exit 1
}
print_success "Frontend provisioned"

# Setup database schema after services are provisioned
print_status "Setting up database schema..."
cd apps/backend || {
    print_error "Failed to change to backend directory"
    exit 1
}

if npm run prisma:generate >> $LOG_FILE 2>&1; then
    print_success "Prisma client generated"
else
    print_warning "Prisma generate failed - continuing"
fi

if npx prisma db push --skip-generate >> $LOG_FILE 2>&1; then
    print_success "Database schema ready"
else
    print_warning "Database push failed - continuing"
fi

cd $SEMIONT_ROOT || {
    print_error "Failed to return to SEMIONT_ROOT"
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

cd $SEMIONT_ROOT || {
    print_error "Failed to return to SEMIONT_ROOT"
    exit 1
}

# Don't show verbose welcome - user ran this manually
echo ""

# Check if required secrets are set
print_status "Checking secrets..."

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    print_warning "ANTHROPIC_API_KEY not set (AI features disabled)"
else
    print_success "ANTHROPIC_API_KEY configured"
fi

if [ -z "${NEO4J_URI:-}" ] || [ -z "${NEO4J_USERNAME:-}" ] || [ -z "${NEO4J_PASSWORD:-}" ]; then
    print_warning "Neo4j credentials not set (graph features disabled)"
else
    print_success "Neo4j credentials configured"
fi

echo ""
echo "=========================================="
echo "   ✅ SETUP COMPLETE"
echo "=========================================="
echo ""
print_success "Environment ready!"

# Stay in workspace directory
cd /workspace
echo ""
echo "================================"
echo "Workspace ready!"
echo "To run the demo: cd demo && npm run demo:interactive"
echo "================================"

# Configure bash to start in workspace directory for new terminals
echo "" >> /home/node/.bashrc
echo "# Start in workspace directory" >> /home/node/.bashrc
echo "if [ -d /workspace ]; then" >> /home/node/.bashrc
echo "    cd /workspace" >> /home/node/.bashrc
echo "fi" >> /home/node/.bashrc

# Start the backend and frontend services
print_status "Starting services..."
cd $SEMIONT_ROOT || exit 1

semiont start --service backend >> $LOG_FILE 2>&1 &
BACKEND_PID=$!
sleep 3

semiont start --service frontend >> $LOG_FILE 2>&1 &
FRONTEND_PID=$!
sleep 3

# Check service status
if semiont status >> $LOG_FILE 2>&1; then
    print_success "Services started successfully"
else
    print_warning "Services may still be starting"
fi

echo ""
echo "  Backend PID: $BACKEND_PID"
echo "  Frontend PID: $FRONTEND_PID"
echo ""
echo "  Check status: semiont status"
echo "  View logs: semiont logs"