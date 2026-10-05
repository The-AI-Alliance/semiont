# Local development

Local development is built around **[`scripts/ci/local-build.sh`](../../scripts/ci/local-build.sh)**. It builds your working tree into the real service images, and the launcher runs those. What you test is what ships.

## What you need

- **A container runtime**: Apple `container`, Docker or Podman. Nothing else: the script runs npm, cargo and Go inside containers.
- **A knowledge base to run against.** Clone [`semiont-template-kb`](https://github.com/The-AI-Alliance/semiont-template-kb), or see [Knowledge Bases](../KNOWLEDGE-BASES.md) for others.

## The loop

```bash
# 1. In the repository: build the packages, all eight images, and the launcher
./scripts/ci/local-build.sh

# 2. In the knowledge base: run the stack on what you built
cd /path/to/your-kb
SEMIONT_VERSION=local /path/to/semiont/apps/launcher/dist/semiont start
/path/to/semiont/apps/launcher/dist/semiont useradd --email you@example.com

# 3. Change code, then rebuild only what changed (below) and start again

# 4. When you are done
/path/to/semiont/apps/launcher/dist/semiont stop
container stop semiont-verdaccio
```

What a full run does:

1. Builds every npm package, in the order [`version.json`](../../version.json) lists them.
2. Publishes them to a throwaway local registry (Verdaccio), which it leaves running.
3. Builds the eight images from the same Dockerfiles the publish workflows use, tagged `ghcr.io/the-ai-alliance/semiont-<service>:local`. They are never pushed.
4. Loads the images into every container runtime on the machine, so the stack can run under any of them.
5. Builds the launcher from the working tree, as `apps/launcher/dist/semiont`.

Two things make the stack use your build:

- **`SEMIONT_VERSION=local`** has the launcher run the `:local` images and pull nothing. Without it you get the published ones, and your change is not in them.
- **The launcher you just built**, not one installed with Homebrew. The launcher and the images are released together, so a launcher from an earlier release may not match images built from your tree.

### Rebuilding one thing

```bash
./scripts/ci/local-build.sh --package make-meaning --image archivist   # one package, then one image
./scripts/ci/local-build.sh --images-only --image worker               # one image, from what is already published locally
./scripts/ci/local-build.sh --help                                     # every option
```

- A Node image installs its packages from the local registry, so a change to package source reaches an image only after that package is rebuilt and republished. `--images-only` skips that step: use it when the package has not changed.
- The gateway and dispatcher images compile the Rust workspace from the working tree every time, so `--images-only --image gateway` picks up a Rust change.
- `--package` takes a package's directory name (`core`, `make-meaning`), as `version.json` lists them. An unknown name is refused with the list.

The script's own README, [scripts/ci/README.md](../../scripts/ci/README.md), covers the rest.

## Working on one package, without a stack

Most changes do not need a running stack. With Node on your machine:

```bash
npm ci --include=optional
npm run build:packages                  # every library, in dependency order
npm run typecheck                       # tsc --noEmit across the workspaces
npm test --workspace=@semiont/sdk       # one workspace's suite
```

Without it, run the same commands in a container:

```bash
container run --rm -v "$PWD":/work -w /work node:24-alpine \
  sh -c 'npm ci --include=optional && npm run build:packages'
```

For the Rust workspace, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace` are what CI runs. For the launcher, `go vet ./...` and `go test ./...` in `apps/launcher`; its suite takes minutes.

[Testing](TESTING.md) has every suite, what each needs, and how to run it in a container.

## Looking at a running stack

The launcher's verbs work the same on a stack built from source:

```bash
semiont status                     # each service's state and health
semiont logs --service worker      # follow one service
semiont start --service worker     # restart one after rebuilding its image
```

In the Browser's console, `window.__SEMIONT_BUS_LOG__ = true` logs one line for every bus event that page sends and receives, which is often the fastest way to see what a change did: see [Bus logging](../../tests/e2e/docs/bus-logging.md). Every service's traces are at `http://localhost:16686` ([Observability](../operator/administration/OBSERVABILITY.md)).

## Related

- [scripts/ci/README.md](../../scripts/ci/README.md): `local-build.sh` and the build and publish scripts
- [Testing](TESTING.md): the suites and how to run them
- [The service catalog](../operator/services/OVERVIEW.md): what is running, and on which ports
- [Running a local stack](../operator/LOCAL-SEMIONT.md): the launcher from an operator's side
- [Troubleshooting](../operator/administration/TROUBLESHOOTING.md): when a start fails or a service is unhealthy
