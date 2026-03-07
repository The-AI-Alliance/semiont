# Release Process

This document describes the release process for Semiont.

## Overview

Semiont uses a semi-automated release process with three main scripts:
1. **release:publish** - Creates and publishes a stable release
2. **release:await** - Waits for CI/CD to complete the release
3. **release:bump** - Bumps version for next development cycle

## Release Scripts

### Version Management Scripts

```bash
npm run version:show    # Display current version across all packages
npm run version:sync    # Sync version.json to all package.json files
npm run version:bump    # Bump version (patch/minor/major)
npm run version:set     # Set specific version
```

### Release Workflow Scripts

```bash
npm run release:publish # Step 1: Tag and publish stable release
npm run release:await   # Step 2: Wait for CI/CD completion
npm run release:bump    # Step 3: Bump version for next cycle
```

## Release Workflow

### Prerequisites

- Clean working directory (no uncommitted changes)
- On main branch with latest changes
- All tests passing
- Proper npm/GitHub permissions for publishing

### Step 1: Publish Stable Release

```bash
npm run release:publish
```

This script:
- Creates a git tag for the current version (e.g., `v0.2.30`)
- Pushes the tag to GitHub
- Triggers CI/CD to build and publish packages

**What gets published:**
- npm packages to `@semiont/*` with `latest` tag
- Docker containers to GitHub Container Registry

### Step 2: Wait for Release Completion

```bash
npm run release:await
```

This script:
- Monitors GitHub Actions for the release workflow
- Waits for all packages to be published
- Verifies npm and container registries

### Step 3: Bump Version for Development

```bash
npm run release:bump patch  # For bug fixes (0.2.30 → 0.2.31)
npm run release:bump minor  # For features (0.2.30 → 0.3.0)
npm run release:bump major  # For breaking changes (0.2.30 → 1.0.0)
npm run release:bump        # Interactive prompt
```

This script:
- Bumps version in version.json
- Syncs to all package.json files
- Commits and pushes to main
- Next builds will be `{version}-build.N` with `dev` tag

## Version Numbering

### Stable Releases
- Format: `X.Y.Z` (e.g., `0.2.30`)
- Published with npm tag `latest`
- Tagged in git as `vX.Y.Z`

### Development Builds
- Format: `X.Y.Z-build.N` (e.g., `0.2.31-build.1`)
- Published with npm tag `dev`
- Automatically created on each push to main
- Build number increments with each CI run

## Complete Release Example

```bash
# 1. Ensure you're on main with latest changes
git checkout main
git pull

# 2. Check current version
npm run version:show

# 3. Run tests to ensure everything works
npm test

# 4. Publish stable release (e.g., 0.2.30)
npm run release:publish

# 5. Wait for CI/CD to complete
npm run release:await

# 6. Bump version for next development cycle
npm run release:bump patch  # Bumps to 0.2.31

# Next push to main will publish 0.2.31-build.1 with dev tag
```

## Publishing Channels

### npm Packages

**Stable releases:**
```bash
npm install @semiont/core@latest
npm install @semiont/cli@latest
```

**Development builds:**
```bash
npm install @semiont/core@dev
npm install @semiont/cli@dev
```

**View all versions:**
- https://www.npmjs.com/settings/semiont/packages

### Container Images

**GitHub Container Registry:**
- https://github.com/orgs/The-AI-Alliance/packages?repo_name=semiont

**Images:**
- `ghcr.io/the-ai-alliance/semiont/backend:latest`
- `ghcr.io/the-ai-alliance/semiont/frontend:latest`
- `ghcr.io/the-ai-alliance/semiont/backend:dev`
- `ghcr.io/the-ai-alliance/semiont/frontend:dev`

## Version Bump Guidelines

### Patch Version (X.Y.Z → X.Y.Z+1)
Use for:
- Bug fixes
- Documentation updates
- Dependency updates (non-breaking)
- Performance improvements

### Minor Version (X.Y.Z → X.Y+1.0)
Use for:
- New features (backward compatible)
- New APIs or commands
- Significant improvements
- New platform support

### Major Version (X.Y.Z → X+1.0.0)
Use for:
- Breaking API changes
- Major architectural changes
- Incompatible configuration changes
- Removal of deprecated features

## CI/CD Integration

The release process triggers GitHub Actions workflows:

1. **On tag push** (`v*` tags):
   - Builds all packages
   - Runs full test suite
   - Publishes npm packages with `latest` tag
   - Builds and pushes Docker containers with `latest` tag

2. **On main branch push**:
   - Builds all packages
   - Runs tests
   - Publishes npm packages with `dev` tag
   - Builds and pushes Docker containers with `dev` tag

## Troubleshooting

### Release script fails

1. Check git status - ensure clean working directory
2. Verify you're on main branch
3. Check npm/GitHub authentication
4. Review error messages for specific issues

### CI/CD build fails

1. Check GitHub Actions: https://github.com/The-AI-Alliance/semiont/actions
2. Review build logs for errors
3. Ensure all tests pass locally
4. Verify version consistency across packages

### Package not published

1. Check npm permissions: `npm whoami`
2. Verify organization membership
3. Check GitHub Actions secrets are configured
4. Review publish logs in CI/CD

## Manual Release (Emergency)

If automated release fails, you can manually release:

```bash
# 1. Set version
npm run version:set 0.2.30
npm run version:sync

# 2. Create and push tag
git tag v0.2.30
git push origin v0.2.30

# 3. CI/CD will handle the rest
# Monitor at: https://github.com/The-AI-Alliance/semiont/actions
```

## Release Checklist

Before releasing:
- [ ] All tests passing
- [ ] Documentation updated
- [ ] CHANGELOG.md updated (if maintained)
- [ ] No uncommitted changes
- [ ] On main branch with latest changes

After releasing:
- [ ] Verify npm packages published
- [ ] Verify Docker containers published
- [ ] Test installation: `npm install @semiont/cli@latest`
- [ ] Announce release (if major/minor version)

## Questions?

For questions about the release process:
- Open a [GitHub Discussion](https://github.com/The-AI-Alliance/semiont/discussions)
- Review [CONTRIBUTING.md](CONTRIBUTING.md) for general contribution guidelines