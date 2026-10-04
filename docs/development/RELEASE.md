# Release Process

This document describes the release process for Semiont.

## Overview

Semiont publishes a release in these steps:
1. **Release workflow** — tags the version, publishes all npm packages, and —
   when the **Build and publish desktop apps** box is checked — builds and
   publishes the desktop apps.
2. **Publish Browser Container Image** — a separate action that pushes the
   `semiont-browser` image to GHCR, run *after* the npm packages exist (it
   verifies the version on npm first). See
   [Step 1b](#step-1b-publish-the-browser-container-image).
3. **Publish Service Images** — a separate action
   ([`publish-service-images.yml`](../../.github/workflows/publish-service-images.yml))
   that pushes the seven service images (`semiont-gateway`, `-worker`,
   `-smelter`, `-weaver`, `-archivist`, `-librarian`, `-dispatcher`) to GHCR. Also run *after* the npm packages exist —
   the six sidecar images bundle the published `@semiont/*` packages at the
   release version, gated on every published `@semiont/*` package being
   *installable* at that version — tarball fetchable, not merely listed in the
   registry metadata. The gateway image compiles `apps/gateway` from the
   commit the workflow runs on, so run it at the release tag. Same knobs as the Browser
   image (Trivy vuln + license gates, `dry_run`, `tag_latest`, provenance +
   SBOM attestations):
   ```bash
   gh workflow run publish-service-images.yml --field version=<version> --field tag_latest=true
   ```
   KB stacks consume these images directly — see
   [Container Images](../system/administration/IMAGES.md).
4. **Launcher Release** — a separate action
   ([`launcher-release.yml`](../../.github/workflows/launcher-release.yml))
   that publishes the `semiont` launcher (the host binary that runs KB
   stacks): goreleaser builds darwin/linux/windows × arm64/amd64 static binaries,
   attaches them (with checksums + SBOMs) to the GitHub Release, attests
   provenance, and pushes the Homebrew formula to
   `The-AI-Alliance/homebrew-semiont`. Unlike the image workflows it takes
   **no version input** — dispatch it **from the tag ref**:
   ```bash
   gh workflow run launcher-release.yml --ref v<version>
   ```
   See [Step 1c](#step-1c-publish-the-launcher-homebrew--binaries).
5. **Stack Smoke** — an optional gate
   ([`stack-smoke.yml`](../../.github/workflows/stack-smoke.yml)) that boots a
   real stack from a published image set and asserts what the launcher's
   hermetic suite cannot, by running
   [`scripts/release/smoke-stack.sh`](../../scripts/release/smoke-stack.sh),
   which says what it checks. Run it after the
   images exist at `:<version>` and **before** `latest` is moved to them —
   both publish workflows default `tag_latest` to false, so that ordering is
   the natural one, and this is the gate that decides whether `latest` should
   move:
   ```bash
   gh workflow run stack-smoke.yml --field images=<version>
   ```
   It builds the launcher from the ref it runs on, so it is equally the way to
   test a LAUNCHER change against the current images, from any branch, without
   publishing anything. Without `images`, it builds every image from the ref
   as well (`scripts/ci/local-build.sh`), pushing nothing. The same script
   runs locally with the launcher built
   from your checkout: `scripts/release/smoke-stack.sh <version>`, or `local`
   for the images `scripts/ci/local-build.sh` builds.
6. **release:bump** — bumps the version for the next development cycle.

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
4. **Publishes npm packages** — all `@semiont/*` libraries, CLI, and Browser
5. **Builds and publishes the desktop apps** — only when the **Build and
   publish desktop apps** box (`desktop=true`) is checked; chains the
   `publish-desktop.yml` workflow for macOS (Intel + Apple Silicon) and
   Linux x64


## Step 1b: Publish the Browser Container Image

The npm release does **not** publish the Browser container image — that is a
separate **Publish Browser Container Image** action (`publish-browser.yml`).
Run it *after* the npm packages are live, because it verifies that
`@semiont/browser@<version>` exists on npm before building.

### From the GitHub UI

1. Go to **Actions** > **Publish Browser Container Image**
2. Click **Run workflow**
3. Set **version** to the released version (e.g. `0.5.6`)
4. Check **Also tag as :latest** to move the `:latest` tag to this build
5. Click **Run workflow**

### From the command line

```bash
# Publish the image for 0.5.6 and also tag it :latest
gh workflow run publish-browser.yml --field version=0.5.6 --field tag_latest=true
```

This pushes to GHCR:
- `ghcr.io/the-ai-alliance/semiont-browser:<version>`
- `ghcr.io/the-ai-alliance/semiont-browser:sha-<commit>`
- `ghcr.io/the-ai-alliance/semiont-browser:latest` (only when `tag_latest=true`)


## Step 1c: Publish the Launcher (Homebrew + binaries)

The `semiont` launcher ([`apps/launcher`](../../apps/launcher)) ships from a
separate **Launcher Release** action (`launcher-release.yml`). It is pure Go —
it does not depend on the npm packages — so it can run any time after the tag
exists, in parallel with the image workflows.

Two things make it different from the image workflows:

- **No version input.** goreleaser derives the version from the tag the
  workflow checks out — so dispatch it **from the tag ref**, not a branch.
- **It will not auto-trigger.** It declares `on: push: tags`, but the Release
  workflow pushes the tag with the workflow-scoped `GITHUB_TOKEN`, and GitHub
  suppresses workflow triggers from those events — the manual dispatch is the
  expected path.

### From the command line

```bash
gh workflow run launcher-release.yml --ref v<version>
```

(From the UI: **Actions** > **Launcher Release** > **Run workflow**, and pick
the **tag** `v<version>` in the branch/tag dropdown.)

### What it publishes

- `semiont_<version>_{darwin,linux}_{arm64,amd64}.tar.gz`,
  `semiont_<version>_windows_{arm64,amd64}.zip`, `checksums.txt` and SBOMs,
  attached to the existing GitHub Release (`mode: keep-existing` —
  it never clobbers the release the main pipeline created)
- Build-provenance attestation for the archives
  (`gh attestation verify <archive> -R The-AI-Alliance/semiont`)
- `Formula/semiont.rb` pushed to the
  [`homebrew-semiont`](https://github.com/The-AI-Alliance/homebrew-semiont)
  tap, so users get this version via
  `brew install the-ai-alliance/semiont/semiont`

### One-time prerequisites (already configured)

- The public tap repo `The-AI-Alliance/homebrew-semiont` (initialized with a
  `main` branch).
- The `TAP_GITHUB_TOKEN` Actions secret on this repo: a fine-grained PAT
  scoped to only the tap repo with **Contents: Read and write** — goreleaser
  uses it to push the formula (the built-in `GITHUB_TOKEN` cannot write to
  another repo). If formula pushes start failing with 401/403, this token has
  expired or been revoked — mint a replacement and `gh secret set
  TAP_GITHUB_TOKEN --repo The-AI-Alliance/semiont`.

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
intentionally stays on `npm install` — it stamps `"*"`→exact versions, which
leaves the tree not matching the committed lock.)

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

**Retiring a security `override`:** a top-level version that looks clean is NOT
evidence the override is dead. npm hoists one copy to the root, but a dependency
that pins an *exact* version keeps its own nested copy, and the override may be
the only thing lifting that copy. Before removing an entry from `overrides`,
check every copy, not just the hoisted one:

```bash
jq -r '.packages | to_entries[]
  | select(.key | test("node_modules/<pkg>$"))
  | "\(.value.version)  \(.key)"' package-lock.json
```

If any nested copy sits below the advisory's patched version, the override is
still load-bearing — dropping one while a transitive dependency still pins the
vulnerable version re-opens the alert. Also target
the **newest** fixed release, not the first one that cleared the original
advisory — patched versions routinely draw later CVEs of their own.

## Version Management Scripts

```bash
npm run version:show    # Display current version across all packages
npm run version:sync    # Sync version.json to all package.json files and the published crates
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
in-place libs + cli) and `publish-npm-apps.mjs` (for the staged browser
tarball). `version-bump.sh` and `version:sync` only stamp the `version` field;
they do **not** pin internal deps — those stay `"*"`.

Do **not** hand-pin an internal dep to a concrete version in source: it adds a
maintenance point that drifts and lets a stale published copy substitute for
your workspace — the exact failure this convention removes.

## The gateway is not an npm package

The gateway is Rust (`apps/gateway`). Its image compiles it from the repository
at the commit the image publish runs on — the version it reports is
version.json's, read when it is built — so there is no `@semiont/gateway` to
stage, pin or publish. Its crates are locked in the workspace's `Cargo.lock` and
held to the licence policy by `scripts/lint/check-image-crates.mjs`.

The **Browser** publishes from a staging directory: `apps/browser/package.publish.json`
declares **no** runtime dependencies and nothing derives them, because the
published Browser is a pre-built Vite bundle — its deps are compiled into
`dist/`, not resolved by npm at install time.

## The Rust crates

Four crates of the Rust workspace are published to crates.io: `semiont` (the
SDK), `semiont-codegen` (its build dependency), `semiont-telemetry` and
`semiont-http-transport`. Every other member is `publish = false`, and CI
fails the workspace if the published set is any other.

They carry version.json's version. `scripts/release/cargo-version.sh` writes
it to `Cargo.toml` (`[workspace.package]`, and beside each path of
`[workspace.dependencies]` that names a published crate) and to `Cargo.lock`;
`version-bump.sh` and `npm run version:sync` both run it, and CI fails a
published crate at any other version.

They are published by hand, from a clean checkout of the release's commit, in
dependency order. A version of a crate is permanent: it can be yanked, never
replaced.

```bash
cargo publish -p semiont-codegen
cargo publish -p semiont
cargo publish -p semiont-telemetry
cargo publish -p semiont-http-transport
```

`cargo publish --dry-run --workspace` packages and builds all four against
each other without publishing any.

The SDK's build script reads the spec through `packages/sdk-rust/specs`, a
link to `specs/src` that cargo follows when it packages, so the published
crate carries the spec files it is generated from.

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

Optional `stage` field for an app that publishes from a staging directory
(currently `semiont-browser`):

```json
"semiont-browser": {
  "dir": "apps/browser",
  "stage": ".npm-stage/browser",
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

# 5. After the npm packages are live, publish the container images
#    (Browser + the four service images; the two workflows can run in parallel)
gh workflow run publish-browser.yml --field version=<version> --field tag_latest=true
gh workflow run publish-service-images.yml --field version=<version> --field tag_latest=true

# 5b. Publish the launcher — dispatched FROM THE TAG (no version input);
#     independent of npm, so it can run in parallel with the image workflows
gh workflow run launcher-release.yml --ref v<version>

# 5c. Boot the published images for real, before moving `latest` to them
gh workflow run stack-smoke.yml --field images=<version>

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
npm install @semiont/browser@latest
```

**Development builds:**
```bash
npm install @semiont/core@dev
npm install @semiont/browser@dev
```

**View all versions:**
- https://www.npmjs.com/settings/semiont/packages

### Container Images

The Browser container image is published to GHCR by
[Step 1b](#step-1b-publish-the-browser-container-image), and the four
service images by `publish-service-images.yml`:

```bash
docker pull ghcr.io/the-ai-alliance/semiont-browser:latest
docker pull ghcr.io/the-ai-alliance/semiont-gateway:latest
docker pull ghcr.io/the-ai-alliance/semiont-worker:latest
docker pull ghcr.io/the-ai-alliance/semiont-smelter:latest
docker pull ghcr.io/the-ai-alliance/semiont-weaver:latest
```

All five also carry `:<version>` (e.g. `:0.5.12`) and `:sha-<commit>` tags.

### Launcher (Homebrew tap + release binaries)

Published by [Step 1c](#step-1c-publish-the-launcher-homebrew--binaries):

```bash
brew install the-ai-alliance/semiont/semiont
semiont version   # semiont <version> (commit <sha>, built <date>)
```

Direct downloads (macOS/Linux/Windows, arm64/amd64) live on the GitHub Release
as `semiont_<version>_<os>_<arch>.tar.gz` — `.zip` for Windows — with `checksums.txt`, SBOMs, and
provenance attestations.


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

## Operational Notes

Hard-won checks from running this process:

- **Gate the trigger.** Before `gh workflow run release.yml`, verify: CI is
  `success` on `origin/main`'s **exact HEAD** (not just the latest run), the
  local tree matches origin, `version.json` is correct, and `v<version>` does
  not already exist on origin.
- **A new publishable package needs a one-time seed.** OIDC trusted publishing
  can't create a package: seed it manually at the prior version, configure the
  trusted publisher (repo + `publish-npm-packages.yml`, no environment), then
  release. Skipping this aborts the fail-fast publish mid-list — a partial
  release (`publish.sh` publishes in `version.json` order and stops on error;
  re-running after a fix skips already-published versions).
- **Verify artifacts, not workflow exit codes.** Confirm `dist-tags.latest` on
  the registry for every published package, the desktop assets on the Release,
  and the image tags in the run log (the "Determine tags" step lists tags that
  were never pushed if a later gate fails).
- **Image workflows run in parallel, after npm.** `publish-browser.yml` and
  `publish-service-images.yml` both gate on the npm version existing and take
  the version as an input — so they're unaffected by the next-cycle bump.
  `publish-desktop.yml` instead reads `version.json`: re-run desktop **before**
  bumping, or re-run the failed jobs of the original (version-pinned) release
  run.
- **The launcher workflow's version comes from the ref, not an input.**
  Dispatching `launcher-release.yml` from a *branch* makes goreleaser fail (or
  stamp the wrong version) — always `--ref v<version>`. Because it's pinned to
  the tag, it too is unaffected by the next-cycle bump and can be re-run any
  time.
- **The bump is safe once the tag job completes** — everything downstream is
  pinned to the tagged commit or takes the version as an input.

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
- [ ] Verify npm packages published (including `@semiont/browser`)
- [ ] If desktop was checked, verify the desktop artifacts on the GitHub Release
- [ ] Publish the Browser container image ([Step 1b](#step-1b-publish-the-browser-container-image)) and confirm the `:<version>` and `:latest` tags on GHCR
- [ ] Publish the seven service images (`publish-service-images.yml`) and confirm `semiont-gateway`, `semiont-worker`, `semiont-smelter`, `semiont-weaver`, `semiont-archivist`, `semiont-librarian`, and `semiont-dispatcher` carry `:<version>` and `:latest` on GHCR
- [ ] Publish the launcher ([Step 1c](#step-1c-publish-the-launcher-homebrew--binaries), dispatched `--ref v<version>`) and confirm the four `semiont_<version>_*.tar.gz` archives and the two `semiont_<version>_windows_*.zip` on the GitHub Release and the updated formula in [`homebrew-semiont`](https://github.com/The-AI-Alliance/homebrew-semiont)
- [ ] Test launcher installation: `brew install the-ai-alliance/semiont/semiont && semiont version` (upgrades: `brew upgrade semiont`). a long-deprecated npm package (no longer built from this repo) also installed a `semiont` bin — if `which semiont` does not resolve to the brew copy, that leftover is shadowing the launcher
- [ ] Smoke-test a stack: from a KB directory, `semiont start && semiont status`, then `semiont stop`
- [ ] Bump version for next cycle: `./scripts/release/version-bump.sh`

## Questions?

For questions about the release process:
- Open a [GitHub Discussion](https://github.com/The-AI-Alliance/semiont/discussions)
- Review [CONTRIBUTING.md](../../CONTRIBUTING.md) for general contribution guidelines
