# scripts/release — Version Management

Release lifecycle scripts. `version-bump.sh` runs on the host with just `jq` and `git`
(no npm required). `version.mjs` requires Node/npm.

## Scripts

| Script | Purpose | Requires |
|--------|---------|----------|
| `preflight.sh` | Decide whether origin/main is releasable | `gh`, `jq`, `git` |
| `notes-context.sh` | Assemble PR bodies and planning docs for the post | `gh`, `jq` |
| `announce.sh` | Lint a release post, and post it on `--post` | `gh` |
| `verify-release.sh` | Check a published release across every channel | `gh`, `jq`, `curl` |
| `version-bump.sh` | Bump version across all packages, commit, push the branch | `jq`, `git` |
| `version.mjs` | Show, sync, or set version | `node` |

## Typical Release Flow

One dispatch publishes everything; each stage triggers the next one it unblocks.
Every step is a script, so none of it depends on remembering a flag.

```bash
# 1. Is main releasable? Checks version sync, a free tag, and CI green on the
#    exact origin/main sha. Prints the release command on success.
./scripts/release/preflight.sh

# 2. Publish every channel.
gh workflow run release.yml

# 3. Write the post from assembled context, never from commit subjects.
./scripts/release/notes-context.sh          # writes .release-notes-context.md
#    ... read it, draft the post, first line = the discussion title ...
./scripts/release/announce.sh 0.5.34 draft.md          # lint
./scripts/release/announce.sh 0.5.34 draft.md --post   # publish

# 4. Verify the artifacts themselves, not the workflow conclusions.
./scripts/release/verify-release.sh 0.5.34

# 5. Bump on a branch and open the PR.
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

## preflight.sh

Reads `origin/main` over the wire with `git ls-remote` and the contents API, so a
stale or dirty local clone cannot make a bad commit look releasable.

CI status comes from that commit's own check runs. `gh run list --limit 1` is not
used anywhere: it returns whatever run the API surfaces first, which is routinely
not the newest, and has reported a phantom head more than once.

## notes-context.sh

Writes `.release-notes-context.md` (gitignored) holding every substantive PR
merged since the last release **with its full body**, the dependency and bump PRs
listed separately rather than filtered silently, and the planning docs modified
in the same window.

Commit subjects compress away the origin and the measurement — the thing that
makes a post worth reading. Assembling the context first is what stops a post
being written from titles.

## announce.sh

Blocking checks are objectively-wrong things: a release link that resolves
nowhere, a title a reader cannot parse, a `.plans/` path nobody outside the
working tree can open. Style calls — bullet length, whether a deep release
carries a whitepaper section — warn but do not block, because a deliberately
substantive bullet is a legitimate authorial choice and a gate that overrules
taste just gets bypassed.
