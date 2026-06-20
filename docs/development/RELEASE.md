# Release Process

This document describes the release process for Semiont.

## Overview

Semiont publishes a release in these steps:
1. **Release workflow** — tags the version, publishes all npm packages, and —
   when the **Build and publish desktop apps** box is checked — builds and
   publishes the desktop apps.
2. **Publish Frontend Container Image** — a separate action that pushes the
   `semiont-frontend` image to GHCR, run *after* the npm packages exist (it
   verifies the version on npm first). See
   [Step 1b](#step-1b-publish-the-frontend-container-image).
3. **release:bump** — bumps the version for the next development cycle.

## Step 1: Publish a Stable Release

The **Release** workflow handles tagging and npm publishing.

### From the GitHub UI

1. Go to **Actions** > **Release** in the repository:
   https://github.com/The-AI-Alliance/semiont/actions/workflows/release.yml
2. Click **Run workflow**
3. Optionally check **Dry run** to build without publishing
4. Optionally check **Build and publish desktop apps** to also build the
   desktop apps for macOS (Intel + Apple Silicon) and Linux x64
5. Click the green **Run workflow** button
6. Monitor the run — the tag, npm publish, and (if checked) desktop jobs
   appear as nested steps

### From the command line

```bash
# Live release
gh workflow run release.yml

# Live release that also builds and publishes the desktop apps
gh workflow run release.yml --field desktop=true

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
3. **Creates a GitHub Release** with auto-generated release notes from commits and merged PRs
4. **Publishes npm packages** — all `@semiont/*` libraries, CLI, backend, and frontend
5. **Builds and publishes the desktop apps** — only when the **Build and
   publish desktop apps** box (`desktop=true`) is checked; chains the
   `publish-desktop.yml` workflow for macOS (Intel + Apple Silicon) and
   Linux x64


## Step 1b: Publish the Frontend Container Image

The npm release does **not** publish the frontend container image — that is a
separate **Publish Frontend Container Image** action (`publish-frontend.yml`).
Run it *after* the npm packages are live, because it verifies that
`@semiont/frontend@<version>` exists on npm before building.

### From the GitHub UI

1. Go to **Actions** > **Publish Frontend Container Image**
2. Click **Run workflow**
3. Set **version** to the released version (e.g. `0.5.6`)
4. Check **Also tag as :latest** to move the `:latest` tag to this build
5. Click **Run workflow**

### From the command line

```bash
# Publish the image for 0.5.6 and also tag it :latest
gh workflow run publish-frontend.yml --field version=0.5.6 --field tag_latest=true
```

This pushes to GHCR:
- `ghcr.io/the-ai-alliance/semiont-frontend:<version>`
- `ghcr.io/the-ai-alliance/semiont-frontend:sha-<commit>`
- `ghcr.io/the-ai-alliance/semiont-frontend:latest` (only when `tag_latest=true`)


## Step 2: Bump Version for Next Cycle

After the release completes, bump the version for the next development cycle:

```bash
./scripts/release/version-bump.sh patch  # Bug fixes (0.4.9 → 0.4.10)
./scripts/release/version-bump.sh minor  # New features (0.4.9 → 0.5.0)
./scripts/release/version-bump.sh major  # Breaking changes (0.4.9 → 1.0.0)
./scripts/release/version-bump.sh        # Interactive prompt
```

This script:
- Bumps the version in `version.json`
- Syncs to all `package.json` files
- Regenerates `package-lock.json` to match (npm, run in a container)
- Commits (signed) and pushes to main

### Lockfile policy

The bump regenerates `package-lock.json` (`npm install --package-lock-only
--include=optional`, run in a `node:24` container — the release host has no
Node) and stages it in the same commit, so the committed lock always records
the bumped versions. This keeps `npm ci` usable for reproducible/clean installs
(release seed builds, Docker images) — and the **CI test/build jobs run
`npm ci --include=optional`**, so any lockfile drift fails the build loudly at
install instead of being silently healed by `npm install`. (The publish workflow
intentionally stays on `npm install` — it stamps `"*"`→exact versions, after
which the tree no longer matches the committed lock.)

**Contributor rule:** any dependency change must commit the regenerated
`package-lock.json` — regenerate with `npm install --package-lock-only
--include=optional` in a `node:24` container; `npm ci` now rejects an out-of-sync
lock, so an uncommitted lock turns CI red. Do not hand-edit the lock to "fix" a
version: a
lockfileVersion-3 file records each workspace version in several interlinked
places (the `packages` map, app dependency pins, `link: true` entries), and only
npm rewrites it consistently. `--include=optional` is required so the
per-platform native pins (`@rolldown/binding-*`, `lightningcss-*`) stay in the
lock.

## Version Management Scripts

```bash
npm run version:show    # Display current version across all packages
npm run version:sync    # Sync version.json to all package.json files
npm run version:bump    # Bump version (patch/minor/major)
npm run version:set     # Set a specific version
```

## Internal dependency pinning

Workspace packages depend on each other (`@semiont/*` / `semiont-*`). The rule:

- **In source, internal deps are `"*"`.** That links the local workspace in dev
  (any version satisfies `"*"`) and **can never drift** — a `"*"` range is never
  stale, so a clean `npm ci` always resolves to your source, never a stale
  published copy from the npm cache.
- **At publish, `"*"` is rewritten to the exact release version.** We publish
  every package at every version, so an exact pin always resolves to a matching
  sibling and a published tarball can never pull a mismatched internal version.

There is exactly **one** implementation of that rewrite —
`scripts/ci/stamp-internal-deps.mjs` (`stampInternalDeps`) — used by both
publish paths: `scripts/ci/stamp-versions.mjs` (invoked by `publish.sh`, for the
in-place libs + cli) and `publish-npm-apps.mjs` (for the staged backend/frontend
tarballs). `version-bump.sh` and `version:sync` only stamp the `version` field;
they do **not** pin internal deps — those stay `"*"`.

Do **not** hand-pin an internal dep to a concrete version in source: it adds a
maintenance point that drifts and lets a stale published copy substitute for
your workspace — the exact failure this convention removes.

## External dependency ranges: derived at publish (backend)

The backend publishes from a staging directory, so it needs a publish-only
manifest (`apps/backend/package.publish.json`) — the published package has a
different `name` (`@semiont/backend` vs `semiont-backend`), adds `bin`/`files`/
`publishConfig`, and drops dev tooling. That template holds **only the publish
metadata that differs from source**. It does **not** re-declare dependencies.

The same single-source-of-truth rule as internal pinning applies to *external*
runtime deps: **source `apps/backend/package.json` is the single source of truth
for external version ranges.** At staging, `stageBackend`
(`scripts/ci/publish-npm-apps.mjs`) builds the published `dependencies` by:

1. Taking `apps/backend/package.json` `dependencies` verbatim — both the
   external ranges and the internal `@semiont/*` set. They are read from source,
   so they **can never drift** from it.
2. Promoting the curated runtime deps that source keeps as `devDependencies`
   (`BACKEND_RUNTIME_DEVDEPS` — currently just `prisma`, the migration CLI the
   deployed package runs). Their ranges also come from source.
3. Pinning the internal `@semiont/*` deps to the exact release version via the
   shared `stampInternalDeps` (see **Internal dependency pinning** above).

Do **not** add a `dependencies` block to `package.publish.json` — the staging
script overwrites it, so hand-authored entries there are silently ignored. To
add a runtime dependency, add it to `apps/backend/package.json`. If it must stay
a `devDependency` in source but ship at runtime (like `prisma`), add it to
`BACKEND_RUNTIME_DEVDEPS` in `scripts/ci/publish-npm-apps.mjs`.

This replaced a hand-maintained copy of the dep ranges in
`package.publish.json` that drifted from source on every dependency bump (it had
shipped a `@hono/node-server` *major* behind source, and had dropped
`@semiont/observability` entirely even though the built backend imports it at
startup).

The **frontend** is deliberately different: `apps/frontend/package.publish.json`
declares **no** runtime dependencies and nothing derives them, because the
published frontend is a pre-built Vite bundle — its deps are compiled into
`dist/`, not resolved by npm at install time.

## Package manifest: `version.json`

`version.json` is the workspace's single source of truth for the
package list. Every script that walks the package set reads from it:

- `scripts/dev/build-packages.js` — build orchestrator (used by
  `npm run build`)
- `scripts/ci/build.sh` — CI build (libraries + apps in dependency
  order)
- `scripts/ci/publish.sh` — version stamping + npm publish
- `scripts/release/version-bump.sh` and `scripts/release/version.mjs` —
  version management
- `.github/workflows/publish-npm-packages.yml` — release-summary readout

Each entry in `version.json.packages` looks like:

```json
"@semiont/core": {
  "dir": "packages/core",
  "version": "0.4.22",
  "publish": true
}
```

Optional `stage` field for apps that publish from a staging directory
(currently `semiont-backend` and `semiont-frontend`):

```json
"semiont-backend": {
  "dir": "apps/backend",
  "stage": ".npm-stage/backend",
  "version": "0.4.22",
  "publish": true
}
```

Insertion order in the `packages` object is the build order — list
each package after its dependencies.

### Adding a new workspace package

1. Create the package directory and its `package.json` as usual. Pin any
   internal `@semiont/*` dependencies as `"*"`, never a concrete version (see
   **Internal dependency pinning** above).
2. Add an entry to `version.json` in the right dependency-order
   position, with `publish: true` if it should ship to npm or
   `publish: false` for internal packages (test helpers, MCP
   integration, the desktop app).
3. That's it. Every script picks it up automatically — no other
   list to update.

If you forget step 2, `local-build.sh` will silently skip the package,
the npm install for any consumer will 404, and you'll waste an hour
chasing it. (Speaking from experience.)

## Complete Release Example

```bash
# 1. Ensure you're on main with latest changes
git checkout main
git pull

# 2. Check version, run tests, and the e2e smoke suite
npm run version:show
npm test
# e2e: containerized run against a local stack — see tests/e2e/README.md

# 3. Publish stable release (add --field desktop=true to also ship desktop apps)
gh workflow run release.yml

# 4. Monitor until complete
gh run list --workflow=release.yml --limit=1
gh run watch <run-id> --exit-status

# 5. After the npm packages are live, publish the frontend container image
gh workflow run publish-frontend.yml --field version=<version> --field tag_latest=true

# 6. Bump version for next development cycle
./scripts/release/version-bump.sh patch
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

### Container Images

The frontend container image is published to GHCR by
[Step 1b](#step-1b-publish-the-frontend-container-image):

```bash
docker pull ghcr.io/the-ai-alliance/semiont-frontend:0.5.6
docker pull ghcr.io/the-ai-alliance/semiont-frontend:latest
```


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

# 2. Trigger release
gh workflow run release.yml
```

## Release Checklist

Before releasing:
- [ ] All tests passing
- [ ] e2e smoke suite green against a local stack — see
      [tests/e2e/README.md](../../tests/e2e/README.md) (note the host-gateway
      CORS setup the containerized run requires)
- [ ] No uncommitted changes — anything not on `origin/main` is **not** in the tag
- [ ] On main branch with latest changes
- [ ] Version in `version.json` is correct

After releasing:
- [ ] Verify npm packages published (including `@semiont/backend` and `@semiont/frontend`)
- [ ] If desktop was checked, verify the desktop artifacts on the GitHub Release
- [ ] Publish the frontend container image ([Step 1b](#step-1b-publish-the-frontend-container-image)) and confirm the `:<version>` and `:latest` tags on GHCR
- [ ] Test installation: `npm install -g @semiont/cli@latest && semiont init && semiont provision`
- [ ] Bump version for next cycle: `./scripts/release/version-bump.sh`

## Questions?

For questions about the release process:
- Open a [GitHub Discussion](https://github.com/The-AI-Alliance/semiont/discussions)
- Review [CONTRIBUTING.md](../../CONTRIBUTING.md) for general contribution guidelines
