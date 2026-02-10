#!/bin/bash

# Enhanced error handling
set -euo pipefail

# Force unbuffered output so logs appear immediately
exec 2>&1
export PYTHONUNBUFFERED=1

# Service startup log
LOG_FILE="/tmp/semiont-services.log"
echo "Starting semiont services at $(date)" > $LOG_FILE

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

# Error handler (non-fatal for service startup)
error_handler() {
    local line_no=$1
    local exit_code=$2
    print_error "Service startup script encountered error at line $line_no with exit code $exit_code"
    print_error "Last command: ${BASH_COMMAND}"
    # Don't exit - we want the container to stay running
}

trap 'error_handler ${LINENO} $?' ERR

# Load credentials saved by setup script
CREDS_FILE="/tmp/semiont-credentials.txt"
if [ -f "$CREDS_FILE" ]; then
    source "$CREDS_FILE"
else
    print_warning "Credentials file not found - may be a container restart"
    # Try to read from persistent location
    if [ -f "/workspace/credentials.json" ]; then
        ADMIN_EMAIL=$(grep -oP '"email":\s*"\K[^"]+' /workspace/credentials.json)
        ADMIN_PASSWORD=$(grep -oP '"password":\s*"\K[^"]+' /workspace/credentials.json)
    fi
fi

echo ""
echo "=========================================="
echo "   SEMIONT SERVICE STARTUP"
echo "=========================================="
echo ""

# Start the backend and frontend services
print_status "Starting services..."
cd ${SEMIONT_ROOT:-/workspace/project} || {
    print_error "SEMIONT_ROOT not set or directory missing"
    # Continue anyway, might be a fresh restart
}

# Stop any existing services first
print_status "Stopping any existing services..."
semiont stop >> $LOG_FILE 2>&1 || {
    print_warning "No services to stop or stop failed - continuing"
}

# Start backend service
semiont start --service backend >> $LOG_FILE 2>&1 || {
    print_error "Backend service failed to start - check $LOG_FILE"
    # Don't exit - log the error and continue
}
print_success "Backend service started"

# Start frontend service
semiont start --service frontend >> $LOG_FILE 2>&1 || {
    print_error "Frontend service failed to start - check $LOG_FILE"
    # Don't exit - log the error and continue
}
print_success "Frontend service started"

# Start Envoy proxy for path-based routing
print_status "Starting Envoy proxy..."
# Double-fork wrapper script daemonizes Envoy (reparents to init/PID 1)
ENVOY_LOG="/tmp/envoy.log"
if [ -f /workspace/.devcontainer/start-envoy.sh ]; then
    chmod +x /workspace/.devcontainer/start-envoy.sh
    /workspace/.devcontainer/start-envoy.sh

    # Give Envoy a moment to start
    sleep 3

    # Verify Envoy is listening on port 8080
    if netstat -tln | grep -q ':8080.*LISTEN'; then
        print_success "Envoy proxy started and listening on port 8080"
        print_info "Envoy logs: $ENVOY_LOG"
    else
        print_error "Envoy failed to start - check $ENVOY_LOG"
    fi
else
    print_warning "start-envoy.sh not found - skipping Envoy startup"
fi

# Check service status (non-fatal)
print_status "Checking service status..."
if semiont check >> $LOG_FILE 2>&1; then
    print_success "All services running"
else
    print_warning "Some services may not be fully ready yet"
    print_info "You can check status manually with: semiont check"
fi

# Change to workspace directory for user
cd /workspace 2>/dev/null || true

# Display welcome message
echo ""
if [ -f /workspace/.devcontainer/welcome.txt ]; then
    cat /workspace/.devcontainer/welcome.txt
fi

# Call to action
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
if [ -n "${CODESPACE_NAME:-}" ]; then
    ENVOY_URL="https://${CODESPACE_NAME}-8080.app.github.dev"
    FRONTEND_URL="https://${CODESPACE_NAME}-3000.app.github.dev"
    BACKEND_HEALTH_URL="https://${CODESPACE_NAME}-4000.app.github.dev/api/health"

    echo "📋 SETUP STEPS (Codespaces):"
    echo ""
    echo "1. Make port 8080 public (Envoy proxy - main entry point):"
    echo "   • Open the 'Ports' panel (View → Ports)"
    echo "   • Right-click port 8080 → Port Visibility → Public"
    echo ""
    echo "2. Open the application via Envoy (recommended):"
    echo "   $ENVOY_URL"
    echo ""
    echo "3. Alternative: Direct access to services"
    echo "   • Frontend: $FRONTEND_URL"
    echo "   • Backend health: $BACKEND_HEALTH_URL"
    echo ""
    if [ -n "${ADMIN_EMAIL:-}" ]; then
        echo "4. Sign in with your admin credentials:"
        echo ""
        echo "   Email:    $ADMIN_EMAIL"
        echo "   Password: $ADMIN_PASSWORD"
        echo ""
        echo "   (These credentials are unique to this Codespace)"
        echo ""
        # Write credentials to JSON file if they don't exist
        WORKSPACE_CREDS="/workspace/credentials.json"
        if [ ! -f "$WORKSPACE_CREDS" ]; then
            cat > "$WORKSPACE_CREDS" << EOF
{
  "email": "$ADMIN_EMAIL",
  "password": "$ADMIN_PASSWORD",
  "environment": "codespace",
  "codespace_name": "$CODESPACE_NAME",
  "created_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
            echo "   📄 Credentials saved to: credentials.json"
        fi
    else
        echo "4. Sign in with credentials from: /workspace/credentials.json"
    fi
    echo ""
    echo "📌 Note: Path-based routing via Envoy:"
    echo "   • /resources/*, /annotations/*, etc. → Backend"
    echo "   • /api/auth/*, /api/cookies/* → Frontend"
    echo "   • /* → Frontend pages"
else
    echo "🚀 Ready to start! Open the application:"
    echo ""
    echo "   http://localhost:8080 (Envoy proxy - recommended)"
    echo "   http://localhost:3000 (Frontend direct)"
    echo "   http://localhost:4000/api/health (Backend health check)"
    echo ""
    if [ -n "${ADMIN_EMAIL:-}" ]; then
        echo "   Sign in with your admin credentials:"
        echo ""
        echo "   Email:    $ADMIN_EMAIL"
        echo "   Password: $ADMIN_PASSWORD"
        echo ""
        # Write credentials to JSON file if they don't exist
        WORKSPACE_CREDS="/workspace/credentials.json"
        if [ ! -f "$WORKSPACE_CREDS" ]; then
            cat > "$WORKSPACE_CREDS" << EOF
{
  "email": "$ADMIN_EMAIL",
  "password": "$ADMIN_PASSWORD",
  "environment": "localhost",
  "created_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
            echo "   📄 Credentials saved to: credentials.json"
        fi
    else
        echo "   Sign in with credentials from: /workspace/credentials.json"
    fi
    echo ""
    echo "📌 Note: Path-based routing via Envoy:"
    echo "   • /resources/*, /annotations/*, etc. → Backend (port 4000)"
    echo "   • /api/auth/*, /api/cookies/* → Frontend (port 3000)"
    echo "   • /* → Frontend pages"
fi
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "⚙️  Environment: ${SEMIONT_ENV:-unknown}"
echo ""
if [ "${SEMIONT_ENV:-}" = "local-production" ]; then
    echo "   Running in PRODUCTION mode (builds enabled)"
    echo "   To switch to DEVELOPMENT mode (faster, skip builds):"
    echo "   • Edit .devcontainer/devcontainer.json"
    echo "   • Change SEMIONT_ENV to 'local'"
    echo "   • Rebuild the devcontainer"
else
    echo "   Running in DEVELOPMENT mode (builds skipped)"
    echo "   To switch to PRODUCTION mode (validate builds):"
    echo "   • Edit .devcontainer/devcontainer.json"
    echo "   • Change SEMIONT_ENV to 'local-production'"
    echo "   • Rebuild the devcontainer"
fi
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

print_success "Services started successfully!"
echo "[$(date '+%H:%M:%S')] Service startup complete" >> $LOG_FILE
