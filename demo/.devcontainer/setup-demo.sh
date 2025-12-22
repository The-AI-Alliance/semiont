#!/bin/bash
set -euo pipefail

# Force unbuffered output
exec 2>&1
export PYTHONUNBUFFERED=1

SEMIONT_VERSION="${SEMIONT_VERSION:-0.2.0}"
DEMO_EMAIL="demo@example.com"
DEMO_PASSWORD="demo123"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

print_status() {
    echo -e "\n${BLUE}▶${NC} $1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1" >&2
}

clear

echo "=========================================="
echo "   SEMIONT DEMO ENVIRONMENT SETUP"
echo "=========================================="
echo ""
echo "Version: $SEMIONT_VERSION"
echo ""
echo "📋 Setup Steps:"
echo "  • Install Semiont CLI"
echo "  • Install demo dependencies"
echo "  • Wait for services to start"
echo "  • Create demo user"
echo "  • Save configuration"
echo ""
echo "⏱️  Estimated time: 1-2 minutes"
echo "------------------------------------------"
echo ""

# Navigate to demo directory
cd /workspaces/semiont/demo

# Install Semiont CLI globally
print_status "Installing @semiont/cli@$SEMIONT_VERSION globally..."
npm install -g "@semiont/cli@$SEMIONT_VERSION" 2>&1 | grep -v "npm warn"
print_success "CLI installed"

# Verify CLI installation
if ! command -v semiont &> /dev/null; then
    print_warning "CLI command 'semiont' not found in PATH, but package is installed"
else
    print_success "CLI available: $(semiont --version 2>/dev/null || echo 'installed')"
fi

# Install demo dependencies
print_status "Installing demo dependencies..."
npm install 2>&1 | grep -v "npm warn" | tail -5
print_success "Dependencies installed"

# Wait for backend service to be healthy
print_status "Waiting for backend service to start..."
MAX_WAIT=120
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
    if curl -sf http://localhost:4000/health > /dev/null 2>&1; then
        print_success "Backend is healthy"
        break
    fi
    sleep 2
    WAITED=$((WAITED + 2))
    if [ $((WAITED % 10)) -eq 0 ]; then
        echo "  Still waiting... (${WAITED}s)"
    fi
done

if [ $WAITED -ge $MAX_WAIT ]; then
    print_error "Backend failed to start within ${MAX_WAIT}s"
    echo ""
    echo "Check logs with: docker compose logs backend"
    exit 1
fi

# Wait for frontend service to be healthy
print_status "Waiting for frontend service to start..."
MAX_WAIT=60
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
    if curl -sf http://localhost:3000 > /dev/null 2>&1; then
        print_success "Frontend is healthy"
        break
    fi
    sleep 2
    WAITED=$((WAITED + 2))
    if [ $((WAITED % 10)) -eq 0 ]; then
        echo "  Still waiting... (${WAITED}s)"
    fi
done

if [ $WAITED -ge $MAX_WAIT ]; then
    print_warning "Frontend took longer than expected to start"
    print_warning "It may still be starting - check http://localhost:3000"
fi

# Create demo user
print_status "Creating demo user..."
HTTP_CODE=$(curl -s -w "%{http_code}" -o /tmp/register-response.txt \
  -X POST http://localhost:4000/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$DEMO_EMAIL\",\"password\":\"$DEMO_PASSWORD\",\"name\":\"Demo User\"}")

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    print_success "Demo user created successfully"
elif [ "$HTTP_CODE" = "409" ] || [ "$HTTP_CODE" = "400" ]; then
    print_warning "Demo user already exists (this is fine)"
else
    print_warning "User creation returned HTTP $HTTP_CODE"
    print_warning "You may need to create a user manually"
fi

# Save credentials to .env
print_status "Saving configuration to .env..."
cat > .env <<EOF
# Semiont Demo Environment Configuration
SEMIONT_VERSION=$SEMIONT_VERSION
SEMIONT_API_URL=http://localhost:4000

# Demo Account Credentials
DEMO_EMAIL=$DEMO_EMAIL
DEMO_PASSWORD=$DEMO_PASSWORD

# Optional: Add your API keys here for advanced features
# ANTHROPIC_API_KEY=
# NEO4J_URI=
# NEO4J_USERNAME=
# NEO4J_PASSWORD=
# NEO4J_DATABASE=
EOF
print_success "Configuration saved"

echo ""
echo "=========================================="
echo "   ✅ DEMO ENVIRONMENT READY!"
echo "=========================================="
echo ""
echo "🌐 Frontend:  http://localhost:3000"
echo "🔌 Backend:   http://localhost:4000"
echo "📊 Database:  postgresql://semiont:semiont@localhost:5432/semiont_demo"
echo ""
echo "👤 Demo Account:"
echo "   Email:    $DEMO_EMAIL"
echo "   Password: $DEMO_PASSWORD"
echo ""
echo "🎯 Quick Start:"
echo ""
echo "   1. Visit http://localhost:3000 and login"
echo "   2. Run interactive demo:"
echo "      npm run demo:interactive"
echo ""
echo "📖 Documentation:"
echo "   • Demo guide:      cat README.md"
echo "   • Container info:  cat CONTAINER.md"
echo "   • Datasets:        cat datasets/README.md"
echo ""
echo "🔧 Useful Commands:"
echo "   • Check services:  docker compose ps"
echo "   • View logs:       docker compose logs -f"
echo "   • Restart backend: docker compose restart backend"
echo ""
echo "🚀 Semiont $SEMIONT_VERSION is ready for exploration!"
echo ""
