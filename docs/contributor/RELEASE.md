# Releasing

One dispatch publishes every channel. Each stage triggers the next one it unblocks, and every step around the dispatch is a script, so nothing depends on remembering a flag.

A release publishes, all at the version in [`version.json`](../../version.json):

| Channel | What | Published by |
|---|---|---|
| npm | Every `@semiont/*` package that `version.json` marks `publish`, and the Browser | [`publish-npm-packages.yml`](../../.github/workflows/publish-npm-packages.yml) |
| GitHub Container Registry | The eight images | [`publish-browser.yml`](../../.github/workflows/publish-browser.yml), [`publish-service-images.yml`](../../.github/workflows/publish-service-images.yml) |
| GitHub Release and the Homebrew tap | The `semiont` launcher, for macOS, Linux and Windows | [`launcher-release.yml`](../../.github/workflows/launcher-release.yml) |
| GitHub Release | The desktop apps, for macOS and Linux | [`publish-desktop.yml`](../../.github/workflows/publish-desktop.yml) |
| crates.io | The four Rust SDK crates | [`publish-crates.yml`](../../.github/workflows/publish-crates.yml) |

## The flow

The scripts are in [`scripts/release/`](../../scripts/release/README.md), which documents each one.

### 1. Check that main is releasable

```bash
./scripts/release/preflight.sh
```

It reads `origin/main` over the wire, so a stale or dirty clone cannot make a bad commit look releasable. It checks that every `package.json` is at `version.json`'s version, that the tag is free, and that CI is green on that exact commit. On success it prints the release command.

To boot a real stack from the commit before releasing it, run the smoke test with no input. It builds every image and the launcher from the ref and pushes nothing:

```bash
gh workflow run stack-smoke.yml
```

### 2. Dispatch the release

```bash
gh workflow run release.yml
```

[`release.yml`](../../.github/workflows/release.yml) then:

1. Verifies the versions again, tags the commit `v<version>`, and creates the GitHub Release.
2. Dispatches the npm publish. When the packages are live, that workflow dispatches both image workflows with `tag_latest=true`: it is the only stage that knows the packages the images install are actually published.
3. Dispatches the launcher release at the tag.
4. Dispatches the crates publish at the tag.
5. Builds and publishes the desktop apps.

Two inputs:

- `--field desktop=false` skips the desktop apps. They are on by default.
- `--field dry_run=true` skips every publish. It still creates the tag and the GitHub Release.

None of the chain uses a `push: tags` trigger. The tag is pushed with the workflow's own token, and GitHub raises no workflow event for such a push.

### 3. Verify what was published

```bash
./scripts/release/verify-release.sh <version>
```

It inspects the artifacts, not the workflows' conclusions: the tag, the release's assets, a downloaded archive hashed against `checksums.txt`, the tap's formula, every published package in the npm registry, every published crate on crates.io with its `.crate` hashed against the index, and for each image both platforms, an attestation whose subject matches the tag's digest, and `latest` resolving to the same digest as the version. It exits non-zero and lists what failed.

To boot the published images:

```bash
gh workflow run stack-smoke.yml --field images=<version>
```

### 4. Announce it

```bash
./scripts/release/notes-context.sh                      # writes .release-notes-context.md
./scripts/release/announce.sh <version> draft.md        # lint the post
./scripts/release/announce.sh <version> draft.md --post # publish it as a Discussion
```

`notes-context.sh` gathers every substantive pull request merged since the last release, with its full body. Write the post from that, not from commit subjects. The draft's first line is the Discussion's title.

### 5. Bump the version

```bash
./scripts/release/version-bump.sh patch    # or minor, or major; no argument prompts
```

On a branch. The script bumps `version.json`, syncs every `package.json` and the published crates, regenerates `package-lock.json` in a container, commits, and pushes the branch. Open a pull request for it and merge it: `main` takes no direct pushes.

The bump is safe as soon as the tag exists. Everything downstream is pinned to the tagged commit or takes the version as an input, with one exception: the desktop workflow reads `version.json`, so re-run a failed desktop build before bumping, or re-run the failed jobs of the original release run.

## What each channel does

### npm packages

[`scripts/ci/build.sh`](../../scripts/ci/build.sh) builds, and [`scripts/ci/publish.sh`](../../scripts/ci/publish.sh) stamps versions and publishes, in `version.json`'s order, stopping at the first failure. A re-run after a fix skips the versions already published. Before publishing, each package's `dist` is checked to resolve under `NodeNext` from a consumer's side.

The Browser publishes from a staging directory, `.npm-stage/browser`: it is a pre-built bundle whose dependencies are compiled in, so its published manifest declares none.

Dispatching the npm workflow on its own, without `stable_release`, publishes a development build: `<version>-build.<run number>`, under the `dev` dist-tag.

### Container images

Each image passes these gates before it is pushed, in order. They fail one at a time, so fixing one can reveal the next:

1. **The packages exist.** A Node image installs the published `@semiont/*` packages at its own version, never a working tree, and the workflow refuses to build until every one is installable. The gateway and dispatcher images compile from the commit instead, which is why they are published from the release tag.
2. **The image is what it should be.** The Rust images are checked to carry no source and to start as documented ([`check-gateway-image.sh`](../../scripts/container/check-gateway-image.sh), [`check-dispatcher-image.sh`](../../scripts/container/check-dispatcher-image.sh)).
3. **Vulnerabilities.** Trivy scans for `HIGH` and `CRITICAL` findings and fails on any that has a fix.
4. **Licences.** See [Dependencies](DEPENDENCIES.md#licences).

Then the image is pushed with its version, `sha-<commit>` and, when `tag_latest` is set, `latest`, and its build provenance and bill of materials are attested.

`tag_latest` defaults to false on both image workflows. The release always passes true. The default governs a manual dispatch, where rebuilding an older version must not move `latest` onto it:

```bash
gh workflow run publish-service-images.yml --field version=<version> --field tag_latest=true
gh workflow run publish-browser.yml --field version=<version> --field dry_run=true
```

What an operator sees of all this is in [Container Images](../operator/administration/IMAGES.md).

### The launcher

goreleaser builds static binaries for macOS, Linux and Windows on `arm64` and `amd64`, attaches the archives with `checksums.txt` and bills of materials to the GitHub Release, attests their provenance, and pushes `Formula/semiont.rb` to the [`homebrew-semiont`](https://github.com/The-AI-Alliance/homebrew-semiont) tap.

Its version comes from the ref it runs on, not from an input. Dispatched from a branch it fails or stamps the wrong version, so by hand it is always:

```bash
gh workflow run launcher-release.yml --ref v<version>
```

It pushes to the tap with the `TAP_GITHUB_TOKEN` secret, a token scoped to the tap repository alone. If the formula push starts failing with a 401 or 403, that token has expired: mint a replacement and set it with `gh secret set TAP_GITHUB_TOKEN --repo The-AI-Alliance/semiont`.

### The desktop apps

Built for macOS on Apple Silicon and Intel and for Linux on x64, and attached to the GitHub Release.

### The Rust crates

Four crates of the Rust workspace are published to crates.io: `semiont` (the SDK), `semiont-codegen` (its build dependency), `semiont-telemetry` and `semiont-http-transport`. Every other member is `publish = false`, and CI fails the workspace if the published set is any other, or if a published crate is at any version but `version.json`'s.

[`publish-crates.yml`](../../.github/workflows/publish-crates.yml) publishes them, at the release's tag. A published version of a crate is permanent: it can be yanked, never replaced. So the workflow:

1. Reads which crates are published, and their order, from cargo: a crate is published after every published crate it depends on.
2. Refuses a crate whose version is not `version.json`'s.
3. Packages every crate and builds each from its packaged form against the others (`cargo publish --dry-run --workspace`), before any is uploaded.
4. Publishes each in order, skipping one already on crates.io at that version, so a run that failed partway can be run again.

crates.io trusts the workflow by name. Each crate's settings on crates.io (Settings → Trusted Publishing) name this repository and `publish-crates.yml`, with no environment, and crates.io gives the run a token that lasts 30 minutes. No token is stored in the repository.

By hand, it is run at the tag. `dry_run` packages and builds and publishes nothing:

```bash
gh workflow run publish-crates.yml --ref v<version>
gh workflow run publish-crates.yml --field dry_run=true
```

The SDK's build script reads the spec through `packages/sdk-rust/specs`, a link to `specs/src` that cargo follows when it packages, so the published crate carries the spec files it is generated from.

## Versions

`version.json` holds the one version every package, image, crate and binary carries, and the list of packages:

```json
"@semiont/core": {
  "dir": "packages/core",
  "version": "<version>",
  "publish": true
}
```

The order of `packages` is the build order, so each package is listed after its dependencies. Every script that walks the packages reads this list: the build, the publish, `local-build.sh` and the version scripts. An app that publishes from a staging directory adds a `stage` field.

```bash
npm run version:show    # the version, across every package
npm run version:sync    # write version.json's version to every package.json and the published crates
npm run version:set     # set a specific version
npm run version:bump    # the bump script
```

Dependencies between packages in this repository are `"*"` in source and are rewritten to the exact version at publish: see [Dependencies](DEPENDENCIES.md#how-packages-here-depend-on-each-other).

## A new package

npm's trusted publishing cannot create a package, and neither can crates.io's. Before the first release that includes a new publishable crate, publish it once by hand with `cargo publish -p <crate>`, then add this repository and `publish-crates.yml` under its Settings → Trusted Publishing on crates.io.

Before the first release that includes a new publishable npm package:

1. Add it to `version.json` ([Adding a package](README.md#adding-a-package)).
2. Publish it once by hand, at the version before the one about to be released. Publish that one package alone, under its published name: for an app, that is the name in its `package.publish.json`, not its key in `version.json`.
3. Configure its trusted publisher on npm: this repository and `publish-npm-packages.yml`, with no environment.

Skipping this stops the publish partway down the list, which leaves a partial release.

## When something goes wrong

- **The release run fails.** Open the run, expand the failed job, and re-run the failed jobs from the run's page. Every stage can also be dispatched on its own.
- **The tag job reports a version mismatch.** Run `npm run version:sync`, and land the result through a pull request.
- **An image's `latest` did not move.** `verify-release.sh` says so. Do not run the image workflow again: it would rebuild the image and move the version tag to a new digest, away from the one already attested. Point `latest` at the manifest that exists instead, by reading the version tag's manifest from the registry and writing the same bytes to `latest`.
- **The launcher's formula was not pushed.** See the token note under [The launcher](#the-launcher).
- **A run log lists a tag that was never pushed.** A workflow's "Determine tags" step prints the tags before the gates run. Trust `verify-release.sh`, not the log.

## Related

- [`scripts/release/README.md`](../../scripts/release/README.md): each release script in detail
- [`scripts/ci/README.md`](../../scripts/ci/README.md): the build and publish scripts
- [Dependencies](DEPENDENCIES.md): the lockfile rule and how internal dependencies are pinned
- [Container Images](../operator/administration/IMAGES.md): tags, and verifying an image
