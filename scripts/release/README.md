# scripts/release — Version Management

Release lifecycle scripts. `version-bump.sh` runs on the host with just `jq` and `git`
(no npm required). `version.mjs` requires Node/npm.

## Scripts

| Script | Purpose | Requires |
|--------|---------|----------|
| `version-bump.sh` | Bump version across all packages, commit, push | `jq`, `git` |
| `version.mjs` | Show, sync, or set version | `node` |

## Typical Release Flow

```bash
# After merging the last branch of the day:
./scripts/release/version-bump.sh patch    # 0.4.10 → 0.4.11

# Trigger the release workflow:
gh workflow run release.yml                # tags + publishes to npmjs.com
```

## version-bump.sh

```bash
./scripts/release/version-bump.sh patch    # Bug fixes
./scripts/release/version-bump.sh minor    # New features
./scripts/release/version-bump.sh major    # Breaking changes
./scripts/release/version-bump.sh          # Interactive prompt
```

Bumps the version in `version.json`, syncs to all `package.json` files,
commits (signed), and pushes to main.

## version.mjs

```bash
npm run version:show    # Display current version across all packages
npm run version:sync    # Sync version.json to all package.json files
npm run version:set     # Set a specific version
```
