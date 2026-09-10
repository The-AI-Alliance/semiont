# scripts/release — Version Management

Release lifecycle scripts. `version-bump.sh` runs on the host with just `jq` and `git`
(no npm required). `version.mjs` requires Node/npm.

## Scripts

| Script | Purpose | Requires |
|--------|---------|----------|
| `version-bump.sh` | Bump version across all packages, commit, push the branch | `jq`, `git` |
| `version.mjs` | Show, sync, or set version | `node` |
| `verify-release.sh` | Check a published release across every channel | `gh`, `jq`, `curl` |

## Typical Release Flow

One dispatch publishes everything; each stage triggers the next one it unblocks.

```bash
# 1. CI green on the commit you intend to release, then:
gh workflow run release.yml --field desktop=true

# 2. When the runs finish, verify the artifacts themselves:
./scripts/release/verify-release.sh 0.5.33

# 3. Announce, then bump on a branch and open the PR:
./scripts/release/version-bump.sh patch
```

`release.yml` tags the commit, creates the GitHub Release, and dispatches
`publish-npm-packages.yml` and `launcher-release.yml`. The npm workflow in turn
dispatches `publish-browser.yml` and `publish-service-images.yml` with
`tag_latest=true`, since it is the only stage that knows the packages the images
bundle are actually published.

Nothing in that chain uses a `push: tags` trigger. Tags are pushed with
`GITHUB_TOKEN`, and GitHub does not raise workflow-triggering events for
`GITHUB_TOKEN`-authored pushes — such a trigger silently never fires.

`tag_latest` still defaults to `false` on the two image workflows. The release
path always passes `true`; the default governs manual dispatches, where
rebuilding an older version must not move `:latest` onto it.

## verify-release.sh

```bash
./scripts/release/verify-release.sh 0.5.33
```

Inspects the artifacts rather than workflow conclusions: tag on origin, release
assets, a downloaded tarball hashed against `checksums.txt`, the tap formula,
every package in `version.json` present in the npm registry, and for all seven
images both platforms, an attestation whose subject matches the tag digest, and
`:latest` resolving to the same digest as the released version. Exits non-zero
listing what failed.

A mutable tag existing proves nothing about where it points, so the `:latest`
check compares against both the released version and the previous one — "never
moved" and "moved somewhere unexpected" are different failures.

## version-bump.sh

```bash
./scripts/release/version-bump.sh patch    # Bug fixes
./scripts/release/version-bump.sh minor    # New features
./scripts/release/version-bump.sh major    # Breaking changes
./scripts/release/version-bump.sh          # Interactive prompt
```

Bumps the version in `version.json`, syncs to all `package.json` files,
commits (signed), and pushes the current branch with `-u origin HEAD`. Bumps go
through a branch and PR; direct pushes to main are disabled.

## version.mjs

```bash
npm run version:show    # Display current version across all packages
npm run version:sync    # Sync version.json to all package.json files
npm run version:set     # Set a specific version
```
