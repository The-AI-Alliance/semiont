# Dependencies

How this repository's dependencies are kept current, how a vulnerable one is fixed, and how the packages here depend on each other.

## Dependabot

[Dependabot](../../.github/dependabot.yml) opens pull requests weekly across six ecosystems:

| Ecosystem | Where |
|---|---|
| npm | the repository root (which covers every workspace), `tests/e2e`, `tests/conformance` |
| Go modules | `apps/launcher`, `packages/sdk-go` |
| Cargo | the Rust workspace at the root; the desktop app's `apps/desktop/src-tauri` |
| The Rust toolchain | [`rust-toolchain.toml`](../../rust-toolchain.toml), which also names every Rust image: the builder stage of the Rust services and the desktop builder |
| GitHub Actions | the workflows |
| Docker | the base images of the Browser and the seven service images |

Packages that must move together are grouped, so they arrive in one pull request: `react`, `i18n`, `bundler-binaries`, `opentelemetry`, `gateway-crates`, `desktop-crates` and `service-base-images`.

`npm run lint:dependabot` fails when a manifest has no Dependabot entry, or an entry has no manifest. A new Dockerfile, lockfile or crate cannot go un-updated without CI saying so.

`npm run lint:rust-toolchain` fails when the Rust version is written anywhere but `rust-toolchain.toml`: a Rust image whose tag is written out, a Dockerfile that does not take `RUST_TOOLCHAIN`, a toolchain picked another way, or a second reader of the file's `channel` beside [`scripts/ci/rust-toolchain.sh`](../../scripts/ci/rust-toolchain.sh). Dependabot moves that one file and runs no script, so a copy would be a copy nothing moves.

`npm run lint:go-toolchain` holds the Go version the same way. Each `go.mod` pins the toolchain, because Go reads no other module's, and the gate fails when the two differ, when a Go image's tag is written out, when a workflow names a Go version in place of a `go.mod`, or when anything but [`scripts/ci/go-toolchain.sh`](../../scripts/ci/go-toolchain.sh) reads the pin.

`npm run lint:python-version` holds the Python the SDK supports. `requires-python` states the floor, a person moves it, and the tools that do not read it keep a copy: mypy, pyright, the classifiers, and the versions CI installs. The gate fails when one of them, a sentence in a document, or a Python image's tag says anything else, and when anything but [`scripts/ci/python-floor.sh`](../../scripts/ci/python-floor.sh) reads the line.

`npm run lint:node-version` holds Node's two versions. [`.node-version`](../../.node-version) names the Node that builds and tests: the workflows read the file, and the scripts ask [`scripts/ci/node-version.sh`](../../scripts/ci/node-version.sh) for their image's tag. `engines.node` is the floor a package asks of whoever installs it, which npm reads from each manifest alone: every manifest states it, and the gate holds them, and the lockfile's copies, to the root's. It fails on a version a workflow writes, on a Node image tag outside a Dockerfile, and on a sentence that states another floor. A Dockerfile's base image is its own, and Dependabot moves it.

The crates the Rust services link are also checked against the RustSec advisory database by [Gateway Crate Advisories](../../.github/workflows/gateway-advisories.yml) (`cargo deny`): on every pull request that changes a `Cargo.toml` or `Cargo.lock`, and daily, because the database changes without a commit. An advisory judged not to reach the services is ignored in [`deny.toml`](../../deny.toml) with its reason, and an ignore that stops matching fails the run.

The npm packages the repository ships are checked against GitHub's advisory database by [npm Advisories](../../.github/workflows/npm-advisories.yml) (`npm audit --omit=dev` over every tracked lockfile): on every pull request that changes a `package.json` or a `package-lock.json`, daily, and first in a [release](../../.github/workflows/release.yml), which creates no tag until it passes. A high or critical advisory fails it. One judged not to reach what ships is ignored in [`.github/npm-advisories.json`](../../.github/npm-advisories.json) with its reason, and an ignore that stops matching fails the run. Development dependencies are outside it; Dependabot's alerts report advisories against those.

## Reviewing a dependency pull request

**Do not merge part of a group.** The `bundler-binaries` group keeps a bundler and its per-platform native binaries (`@rolldown/binding-*`, `lightningcss-*`) on one version. Moving one without the others fails CI with `cannot find module *.linux-x64-gnu.node`.

## Fixing a vulnerable dependency

**Move the consumer forward rather than pinning around it.** Bump the package that pulls in the vulnerable one, regenerate the lockfile, accept the drift, and validate with a real `npm ci`. An `overrides` entry is the last resort, for when no consumer has a release that carries the fix.

**Before retiring an override, check every copy.** A hoisted version that looks clean is not evidence that the override is dead. npm hoists one copy to the root, but a dependency that pins an exact version keeps a nested copy of its own, and the override may be the only thing lifting it:

```bash
jq -r '.packages | to_entries[]
  | select(.key | test("node_modules/<pkg>$"))
  | "\(.value.version)  \(.key)"' package-lock.json
```

If any nested copy is below the advisory's patched version, the override is still doing its job. When you do move a dependency for an advisory, target the newest fixed release, not the first one that cleared it: patched versions routinely draw advisories of their own.

## The lockfile

**Any dependency change commits the regenerated `package-lock.json`.** CI's jobs install with `npm ci --include=optional`, which refuses a lockfile that does not match, so an uncommitted lock turns CI red at install.

Regenerate it with npm, never by hand:

```bash
container run --rm -v "$PWD":/work -w /work "node:$(scripts/ci/node-version.sh)" \
  npm install --package-lock-only --include=optional
```

- A lockfile records each workspace's version in several linked places, and only npm rewrites them consistently.
- `--include=optional` keeps the per-platform native binaries (`@rolldown/binding-*`, `lightningcss-*`) in the lock.
- `tests/e2e` and `tests/conformance` have lockfiles of their own, regenerated the same way from their own directories.

The version bump regenerates the root lockfile itself ([Release](RELEASE.md#5-bump-the-version)). The npm publish is the one place that installs with `npm install` rather than `npm ci`: it rewrites internal dependencies to exact versions first, so its tree deliberately does not match the committed lock.

## How packages here depend on each other

**In source, a dependency on another `@semiont/*` package is `"*"`.** That always resolves to the workspace's own copy, and it can never go stale. A concrete version would: once it stopped matching the workspace's version, npm would install the *published* copy nested under the consumer, and the consumer would build against old code with no error.

**At publish, `"*"` is rewritten to the exact release version.** Every package is published at every version, so an exact pin always finds its sibling, and a published tarball can never pull a mismatched internal version. One function does the rewrite, `stampInternalDeps` in [`scripts/ci/stamp-internal-deps.mjs`](../../scripts/ci/stamp-internal-deps.mjs), and both publish paths use it. The version scripts stamp only the `version` field.

**Every import must be declared.** The workspace hoists, so a package can import something it never declared and work here, then fail for anyone who installs it from npm. CI's `check-phantom-deps` job reads each published `dist` and fails on an import its `package.json` does not declare.

**The Rust crates** take each other by path inside the workspace, and the four published ones carry [`version.json`](../../version.json)'s version. `Cargo.lock` is committed, and CI builds with `--locked`. Which crate may depend on which is checked in CI's `test-gateway` job: the SDK links no HTTP client and no exporter, and a service's telemetry crates stay out of a client's build.

## Licences

The service images pass a licence policy before they are published. For the Node images it reads the image's bill of materials; for the Rust images, [`scripts/lint/check-image-crates.mjs`](../../scripts/lint/check-image-crates.mjs) reads the crates each binary links. [`.github/licenses/exceptions.txt`](../../.github/licenses/exceptions.txt) records licences judged acceptable. It never suppresses a finding.

## Related

- [Release](RELEASE.md): what is published, and the gates an image passes first
- [Testing](TESTING.md#continuous-integration): every CI job
- [Container Images](../operator/administration/IMAGES.md): verifying a published image
