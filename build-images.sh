#!/bin/bash
# Build Docker images for Semiont services

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo -e "${GREEN}Building Semiont Docker images...${NC}"

# Parse arguments
SERVICES="all"
if [ "$1" == "--service" ] && [ -n "$2" ]; then
    SERVICES="$2"
fi

# Function to build an image
build_image() {
    local service=$1
    local dockerfile=$2
    local context=$3
    
    echo -e "${YELLOW}Building $service...${NC}"
    
    if [ -f "$dockerfile" ]; then
        docker build -t "semiont-$service:latest" -f "$dockerfile" "$context"
        echo -e "${GREEN}✓ Built semiont-$service:latest${NC}"
    else
        echo -e "${RED}✗ Dockerfile not found: $dockerfile${NC}"
        return 1
    fi
}

# Build based on service selection
build_backend() {
    build_image "backend" "apps/backend/Dockerfile" "."
}

build_frontend() {
    echo -e "${YELLOW}Building frontend...${NC}"
    
    # Use environment variable or default placeholder
    API_URL="${NEXT_PUBLIC_API_URL:-http://localhost:4000}"
    APP_NAME="${NEXT_PUBLIC_APP_NAME:-Semiont}"
    APP_VERSION="${NEXT_PUBLIC_APP_VERSION:-1.0.0}"
    
    if [ -f "apps/frontend/Dockerfile" ]; then
        docker build \
            --build-arg NEXT_PUBLIC_API_URL="$API_URL" \
            --build-arg NEXT_PUBLIC_APP_NAME="$APP_NAME" \
            --build-arg NEXT_PUBLIC_APP_VERSION="$APP_VERSION" \
            -t "semiont-frontend:latest" \
            -f "apps/frontend/Dockerfile" \
            "."
        echo -e "${GREEN}✓ Built semiont-frontend:latest${NC}"
    else
        echo -e "${RED}✗ Dockerfile not found: apps/frontend/Dockerfile${NC}"
        return 1
    fi
}

# Main build logic
case "$SERVICES" in
    all)
        echo "Building all services..."
        build_backend
        build_frontend
        ;;
    backend)
        build_backend
        ;;
    frontend)
        build_frontend
        ;;
    *)
        echo -e "${RED}Unknown service: $SERVICES${NC}"
        echo "Usage: $0 [--service all|backend|frontend]"
        exit 1
        ;;
esac

echo -e "${GREEN}Build complete!${NC}"

# Show built images
echo -e "\n${GREEN}Built images:${NC}"
docker images | grep semiont || echo "No semiont images found"