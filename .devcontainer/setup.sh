#!/bin/bash

# Enhanced error handling
set -euo pipefail

# Detect environment and log for debugging
echo "=========================================="
echo "   SETUP.SH ENVIRONMENT CHECK"
echo "=========================================="
echo "PWD: $(pwd)"
echo "USER: $(whoami)"
echo "GITHUB_ACTIONS: ${GITHUB_ACTIONS:-<not set>}"
echo "CI: ${CI:-<not set>}"
echo "TERM: ${TERM:-<not set>}"
echo "Skip marker exists: $([ -f /tmp/.skip-startup ] && echo 'yes' || echo 'no')"
echo "PostgreSQL running: $(pg_isready -q 2>/dev/null && echo 'yes' || echo 'no')"
echo "=========================================="
echo ""

# Force unbuffered output so logs appear immediately
exec 2>&1
export PYTHONUNBUFFERED=1

# Generate random admin email and password for this environment
# Uses random hex string for uniqueness (not guessable)
RANDOM_ID=$(openssl rand -hex 8)
ADMIN_EMAIL="dev-${RANDOM_ID}@example.com"
ADMIN_PASSWORD=$(openssl rand -base64 16)

# Create a log file for debugging if needed
LOG_FILE="/tmp/semiont-setup.log"
echo "Starting semiont setup at $(date)" > $LOG_FILE
echo "Generated admin email: $ADMIN_EMAIL" >> $LOG_FILE

echo "=========================================="
echo "   SEMIONT DEVCONTAINER SETUP"
echo "=========================================="
echo ""
echo "📋 Setup Steps:"
echo "  • Install dependencies"
echo "  • Build shared packages"
echo "  • Build & install CLI"
echo "  • Install Envoy proxy"
echo "  • Initialize project"
echo "  • Provision services"
echo "  • Build applications"
echo "  • Setup database"
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

print_info() {
    echo -e "  $1"
    echo "[$(date '+%H:%M:%S')] INFO: $1" >> $LOG_FILE
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

# Verify environment variables are set (fail loudly if not)
print_status "Checking environment..."

if [ -z "${SEMIONT_REPO:-}" ]; then
    print_error "SEMIONT_REPO environment variable is not set"
    echo "  Set this to the path of the semiont repository root"
    exit 1
fi

if [ -z "${SEMIONT_ENV:-}" ]; then
    print_error "SEMIONT_ENV environment variable is not set"
    echo "  Set this to the target environment (e.g., 'local', 'dev', 'prod')"
    exit 1
fi

if [ -z "${SEMIONT_ROOT:-}" ]; then
    print_error "SEMIONT_ROOT environment variable is not set"
    echo "  Set this to the path of the semiont project workspace"
    exit 1
fi

# Export them to ensure they're available to subprocesses
export SEMIONT_REPO
export SEMIONT_ENV
export SEMIONT_ROOT
export NODE_ENV

print_success "Environment ready (SEMIONT_REPO=$SEMIONT_REPO, SEMIONT_ENV=$SEMIONT_ENV)"

# Check Node.js and npm versions
print_status "Checking tools..."
print_success "Node $(node --version), npm $(npm --version)"

# Install Envoy if not already installed
print_status "Installing Envoy proxy..."
if ! command -v envoy &> /dev/null; then
    # Download and install Envoy binary for Linux x86_64
    ENVOY_VERSION="1.28.0"
    ENVOY_URL="https://github.com/envoyproxy/envoy/releases/download/v${ENVOY_VERSION}/envoy-${ENVOY_VERSION}-linux-x86_64"

    curl -L -o /tmp/envoy "$ENVOY_URL" >> $LOG_FILE 2>&1 || {
        print_error "Failed to download Envoy - check $LOG_FILE"
        exit 1
    }

    chmod +x /tmp/envoy
    sudo mv /tmp/envoy /usr/local/bin/envoy

    print_success "Envoy installed: $(envoy --version 2>&1 | head -n 1)"
else
    print_success "Envoy already installed: $(envoy --version 2>&1 | head -n 1)"
fi

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

print_status "Type-checking all workspaces..."
cd /workspace || exit 1
npm run typecheck >> $LOG_FILE 2>&1 || {
    print_error "Typecheck failed - check $LOG_FILE for details"
    exit 1
}
print_success "All typechecks passed"

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

# Copy and configure environment for Codespaces
print_status "Configuring environment..."
mkdir -p environments
cp /workspace/.devcontainer/environments-local.json environments/local.json
cp /workspace/.devcontainer/environments-local-production.json environments/local-production.json

# Update URLs for Codespaces if running in GitHub Codespaces
if [ -n "${CODESPACE_NAME:-}" ]; then
    print_status "Detected GitHub Codespaces environment, updating URLs..."

    # GitHub Codespaces URL format: https://$CODESPACE_NAME-$PORT.app.github.dev
    FRONTEND_URL="https://${CODESPACE_NAME}-3000.app.github.dev"
    ENVOY_URL="https://${CODESPACE_NAME}-8080.app.github.dev"

    # Update both environment configs with Codespaces URLs
    node -e "
    const fs = require('fs');
    const baseConfig = JSON.parse(fs.readFileSync('semiont.json', 'utf-8'));
    if (!baseConfig.site) {
      throw new Error('semiont.json must have site configuration');
    }
    const siteDomain = '${CODESPACE_NAME}-8080.app.github.dev';

    // Update both local and local-production environment files
    ['local', 'local-production'].forEach(env => {
      const envFile = \`environments/\${env}.json\`;
      const config = JSON.parse(fs.readFileSync(envFile, 'utf-8'));
      config.site.domain = siteDomain;
      config.site.oauthAllowedDomains = [siteDomain, ...baseConfig.site.oauthAllowedDomains];
      config.services.frontend.url = '${FRONTEND_URL}';
      config.services.frontend.publicURL = '${ENVOY_URL}';
      config.services.backend.publicURL = '${ENVOY_URL}';
      config.services.backend.corsOrigin = '${ENVOY_URL}';
      fs.writeFileSync(envFile, JSON.stringify(config, null, 2));
    });
    "

    print_success "URLs configured for Codespaces: ${FRONTEND_URL}"
else
    print_success "Environment configuration configured for localhost"
fi

# Provision services individually using Semiont CLI
print_status "Provisioning services..."
cd $SEMIONT_ROOT || {
    print_error "Failed to change to SEMIONT_ROOT directory"
    exit 1
}

# Database is already running via docker-compose, no need to provision
print_success "Database already running via docker-compose"

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

# Publish backend (builds if devMode: false, skips if devMode: true)
print_status "Publishing backend application..."
cd $SEMIONT_ROOT || {
    print_error "Failed to change to SEMIONT_ROOT directory"
    exit 1
}
semiont publish --service backend >> $LOG_FILE 2>&1 || {
    print_error "Backend publish failed - check $LOG_FILE"
    exit 1
}
print_success "Backend published"

# Publish frontend (builds if devMode: false, skips if devMode: true)
print_status "Publishing frontend application..."
cd $SEMIONT_ROOT || {
    print_error "Failed to change to SEMIONT_ROOT directory"
    exit 1
}
semiont publish --service frontend >> $LOG_FILE 2>&1 || {
    print_error "Frontend publish failed - check $LOG_FILE"
    exit 1
}
print_success "Frontend published"

# Push database schema
print_status "Pushing database schema..."
cd /workspace/apps/backend || {
    print_error "Failed to change to backend directory"
    exit 1
}
npx prisma db push --skip-generate >> $LOG_FILE 2>&1 || {
    print_error "Database schema push failed - check $LOG_FILE"
    exit 1
}
print_success "Database schema ready"

# Create admin user
print_status "Creating admin user..."
cd $SEMIONT_ROOT || {
    print_error "Failed to change to SEMIONT_ROOT directory"
    exit 1
}
semiont useradd --email "$ADMIN_EMAIL" --password "$ADMIN_PASSWORD" --admin >> $LOG_FILE 2>&1 || {
    print_error "Admin user creation failed - check $LOG_FILE"
    exit 1
}
print_success "Admin user created: $ADMIN_EMAIL"

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

# Save credentials to a file that start-services.sh can read
CREDS_FILE="/tmp/semiont-credentials.txt"
cat > "$CREDS_FILE" << EOF
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASSWORD
EOF

echo ""
echo "=========================================="
echo "  ✅ ONE-TIME SETUP COMPLETED"
echo "=========================================="
echo ""
print_success "Services will start automatically"
print_info "Check postStartCommand progress in container logs"
echo ""
