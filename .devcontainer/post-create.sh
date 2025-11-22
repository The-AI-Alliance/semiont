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
echo "  • Build shared packages"
echo "  • Build & install CLI"
echo "  • Initialize project"
echo "  • Provision services"
echo "  • Build applications"
echo "  • Setup database"
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

print_status "Building shared packages..."
# Build only the shared packages, not the apps yet
npm run build:packages >> $LOG_FILE 2>&1 || {
    print_error "Package build failed - check $LOG_FILE for details"
    exit 1
}
print_success "Packages built"

print_status "Building Semiont CLI..."

# Build the MCP server package (if not already built)
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
NPM_GLOBAL_BIN=$(npm config get prefix)/bin
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

# Try to connect to PostgreSQL using Node.js since pg_isready might not be available
while ! node -e "
const net = require('net');
const client = new net.Socket();
client.connect(5432, 'localhost', function() {
    client.destroy();
    process.exit(0);
});
client.on('error', function() {
    process.exit(1);
});
setTimeout(() => process.exit(1), 1000);
" 2>/dev/null; do
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

# Copy semiont.json configuration to SEMIONT_ROOT
print_status "Configuring semiont.json..."
cd $SEMIONT_ROOT || exit 1
# Always overwrite to ensure correct configuration
cp /workspace/.devcontainer/semiont.json semiont.json
print_success "semiont.json configured"

# Copy environment configuration for local
print_status "Configuring environment..."
# Always overwrite to ensure correct configuration
mkdir -p environments
cp /workspace/.devcontainer/environments-local.json environments/local.json
print_success "Environment configuration configured"

# Provision services individually using Semiont CLI
print_status "Provisioning services..."
cd $SEMIONT_ROOT || {
    print_error "Failed to change to SEMIONT_ROOT directory"
    exit 1
}

# Database is already running via docker-compose, no need to provision
print_success "Database already running via docker-compose"

# Provision backend service (this creates the proper .env file and admin user)
semiont provision --service backend --admin-email dev@example.com >> $LOG_FILE 2>&1 || {
    print_error "Backend provisioning failed - check $LOG_FILE"
    exit 1
}
print_success "Backend provisioned (admin user: dev@example.com)"

# Provision frontend service (this creates the proper .env.local file)
semiont provision --service frontend >> $LOG_FILE 2>&1 || {
    print_error "Frontend provisioning failed - check $LOG_FILE"
    exit 1
}
print_success "Frontend provisioned"

# Build backend now that we have environment variables
print_status "Building backend application..."
cd /workspace/apps/backend || {
    print_error "Failed to change to backend directory"
    exit 1
}
npm run build >> $LOG_FILE 2>&1 || {
    print_warning "Backend build failed - continuing"
}
print_success "Backend built"

# Setup database schema
print_status "Setting up database schema..."
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

# Build frontend now that we have environment variables
print_status "Building frontend application..."
cd /workspace/apps/frontend || {
    print_error "Failed to change to frontend directory"
    exit 1
}
npm run build >> $LOG_FILE 2>&1 || {
    print_warning "Frontend build failed - continuing"
}
print_success "Frontend built"

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

# Configure bash to start in workspace directory for new terminals
echo "" >> /home/node/.bashrc
echo "# Start in workspace directory" >> /home/node/.bashrc
echo "if [ -d /workspace ]; then" >> /home/node/.bashrc
echo "    cd /workspace" >> /home/node/.bashrc
echo "fi" >> /home/node/.bashrc

# Start the backend and frontend services
print_status "Starting services..."
cd $SEMIONT_ROOT || exit 1

# Stop any existing services first
print_status "Stopping any existing services..."
semiont stop >> $LOG_FILE 2>&1 || {
    print_warning "No services to stop or stop failed - continuing"
}

# Start backend service
semiont start --service backend >> $LOG_FILE 2>&1 || {
    print_error "Backend service failed to start - check $LOG_FILE"
    exit 1
}
print_success "Backend service started"

# Start frontend service
semiont start --service frontend >> $LOG_FILE 2>&1 || {
    print_error "Frontend service failed to start - check $LOG_FILE"
    exit 1
}
print_success "Frontend service started"

# Check service status
if semiont check >> $LOG_FILE 2>&1; then
    print_success "All services running"
else
    print_error "Service check failed"
    exit 1
fi


# Change to workspace directory for user
cd /workspace

# Display welcome message
echo ""
cat /workspace/.devcontainer/welcome.txt