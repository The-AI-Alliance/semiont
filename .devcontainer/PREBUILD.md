# Devcontainer Pre-build

This directory contains configuration for pre-building the development container to speed up Codespace and VS Code Remote Container startup.

## How It Works

1. **GitHub Actions Workflow** (`.github/workflows/devcontainer-prebuild.yml`):
   - Runs automatically when devcontainer config changes
   - Runs weekly on Sunday to keep image fresh
   - Can be triggered manually via workflow dispatch
   - Builds the devcontainer and pushes to GitHub Container Registry (GHCR)

2. **Docker Compose** (`docker-compose.yml`):
   - First tries to pull pre-built image from `ghcr.io/the-ai-alliance/semiont/devcontainer:latest`
   - Falls back to building from Dockerfile if pre-built image not available

3. **Dockerfile** (`Dockerfile`):
   - Based on official Microsoft TypeScript/Node devcontainer
   - Includes all features defined in `devcontainer.json`
   - Can be extended with additional system dependencies

## Benefits

- **Faster startup**: 30-60 seconds instead of 5-10 minutes
- **Consistent environment**: Everyone uses the same pre-built image
- **Automatic updates**: Rebuilds when devcontainer config changes

## First-Time Setup

The first time this workflow runs, it will take 5-10 minutes to build and push the image. After that, all developers will benefit from faster startup.

## Viewing Pre-built Images

Pre-built images are stored at:
https://github.com/orgs/The-AI-Alliance/packages?repo_name=semiont

## Troubleshooting

### Image pull fails
If the pre-built image doesn't exist yet or can't be pulled, the devcontainer will automatically fall back to building from the Dockerfile. This is expected on first use.

### Forcing a rebuild
To force a fresh build:
1. Go to Actions → Pre-build Dev Container
2. Click "Run workflow"
3. Select the main branch
4. Click "Run workflow"

### Testing locally
To test the pre-built image locally:
```bash
cd .devcontainer
docker compose build
docker compose up -d
```

## Cache Strategy

The workflow uses layer caching to speed up subsequent builds:
- Base image layers are cached
- Feature installation layers are cached
- Only changed layers are rebuilt

Weekly rebuilds ensure the base image and dependencies stay up-to-date.
