# Release Process

This document describes the release process for Semiont.

## Overview

Semiont uses a two-step release process:
1. **Release workflow** — Tags the version and publishes all npm packages
2. **release:bump** — Bumps the version for the next development cycle

## Step 1: Publish a Stable Release

The **Release** workflow handles tagging and npm publishing.

### From the GitHub UI

1. Go to **Actions** > **Release** in the repository:
   https://github.com/The-AI-Alliance/semiont/actions/workflows/release.yml
2. Click **Run workflow**
3. Optionally check **Dry run** to build without publishing
4. Click the green **Run workflow** button
5. Monitor the run — the tag and npm publish jobs appear as nested steps

### From the command line

```bash
# Live release
gh workflow run release.yml

# Dry run (builds but does not publish)
gh workflow run release.yml --field dry_run=true
```

Monitor progress:

```bash
# List recent runs
gh run list --workflow=release.yml --limit=3

# Watch a specific run
gh run watch <run-id> --exit-status
```

### What the release workflow does

1. **Verifies version sync** across all `package.json` files
2. **Creates and pushes a git tag** `v{version}` (skips if already exists)
3. **Publishes npm packages** — all `@semiont/*` libraries, CLI, backend, and frontend

### Publishing npm packages independently

The npm publish workflow can also be triggered on its own:

**GitHub UI:** Actions > Publish npm packages > Run workflow

**Command line:**
```bash
gh workflow run publish-npm-packages.yml --field stable_release=true
gh workflow run publish-npm-packages.yml --field dry_run=true
```

## Step 2: Bump Version for Next Cycle

After the release completes, bump the version for the next development cycle:

```bash
./scripts/version-bump.sh patch  # Bug fixes (0.4.9 → 0.4.10)
./scripts/version-bump.sh minor  # New features (0.4.9 → 0.5.0)
./scripts/version-bump.sh major  # Breaking changes (0.4.9 → 1.0.0)
./scripts/version-bump.sh        # Interactive prompt
```

This script:
- Bumps the version in `version.json`
- Syncs to all `package.json` files
- Commits (signed) and pushes to main

## Version Management Scripts

```bash
npm run version:show    # Display current version across all packages
npm run version:sync    # Sync version.json to all package.json files
npm run version:bump    # Bump version (patch/minor/major)
npm run version:set     # Set a specific version
```

## Complete Release Example

```bash
# 1. Ensure you're on main with latest changes
git checkout main
git pull

# 2. Check current version and run tests
npm run version:show
npm test

# 3. Publish stable release
gh workflow run release.yml

# 4. Monitor until complete
gh run list --workflow=release.yml --limit=1
gh run watch <run-id> --exit-status

# 5. Bump version for next development cycle
./scripts/version-bump.sh patch
```

## Version Numbering

### Stable Releases
- Format: `X.Y.Z` (e.g., `0.4.9`)
- Published with npm tag `latest`
- Tagged in git as `vX.Y.Z`

### Development Builds
- Format: `X.Y.Z-build.N` (e.g., `0.4.10-build.1`)
- Published with npm tag `dev`
- Build number increments with each CI run

## Publishing Channels

### npm Packages

**Stable releases:**
```bash
npm install @semiont/core@latest
npm install @semiont/cli@latest
npm install @semiont/backend@latest
npm install @semiont/frontend@latest
```

**Development builds:**
```bash
npm install @semiont/core@dev
npm install @semiont/cli@dev
npm install @semiont/backend@dev
npm install @semiont/frontend@dev
```

**View all versions:**
- https://www.npmjs.com/settings/semiont/packages


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

## Troubleshooting

### Release workflow fails

1. Check the run in GitHub Actions: https://github.com/The-AI-Alliance/semiont/actions/workflows/release.yml
2. Expand the failed child job to see which step failed
3. Re-run failed jobs from the parent run page

### Version mismatch error

The tag job verifies all packages match `version.json`. If they don't:
```bash
npm run version:sync
git add -A && git commit -m "sync versions" && git push
```

### Manual release (emergency)

If the workflow is broken, you can tag and trigger manually:

```bash
# 1. Create and push tag
git tag v0.4.9
git push origin v0.4.9

# 2. Trigger npm publish
gh workflow run publish-npm-packages.yml --field stable_release=true
```

## Release Checklist

Before releasing:
- [ ] All tests passing
- [ ] No uncommitted changes
- [ ] On main branch with latest changes
- [ ] Version in `version.json` is correct

After releasing:
- [ ] Verify npm packages published (including `@semiont/backend` and `@semiont/frontend`)
- [ ] Test installation: `npm install -g @semiont/cli@latest && semiont init && semiont provision`
- [ ] Bump version for next cycle: `./scripts/version-bump.sh`

## Questions?

For questions about the release process:
- Open a [GitHub Discussion](https://github.com/The-AI-Alliance/semiont/discussions)
- Review [CONTRIBUTING.md](../../CONTRIBUTING.md) for general contribution guidelines
