# Local development

Local development is built around **[`scripts/ci/local-build.sh`](../../scripts/ci/local-build.sh)**. It builds your working tree into the real service images, and the launcher runs those. What you test is what ships.

## What you need

- **A container runtime**: Apple `container`, Docker or Podman. Nothing else: the script runs npm, cargo, Go and Python inside containers.
- **A knowledge base to run against.** Clone [`semiont-template-kb`](https://github.com/The-AI-Alliance/semiont-template-kb), or see [Knowledge Bases](../KNOWLEDGE-BASES.md) for others.

## The loop

```bash
# 1. In the repository: build the packages, all eight images, the launcher, and the Python SDK
./scripts/ci/local-build.sh

# 2. In the knowledge base: run the stack on what you built. Name the :local
#    images in .semiont/stack/*.yaml (ghcr.io/the-ai-alliance/semiont-gateway:local,
#    and so on for each service), and the Browser's in the machine's settings
cd /path/to/your-kb
/path/to/semiont/apps/launcher/dist/semiont settings browser-image ghcr.io/the-ai-alliance/semiont-browser:local
/path/to/semiont/apps/launcher/dist/semiont start
/path/to/semiont/apps/launcher/dist/semiont useradd --email you@example.com

# 3. Change code, then rebuild only what changed (below) and start again

# 4. When you are done
/path/to/semiont/apps/launcher/dist/semiont stop
container stop semiont-verdaccio
```

What a full run does:

1. Builds every package of `packages/<language>/<name>`, each in its language's container: the npm packages in the order [`version.json`](../../version.json) lists them, the Rust crates with `cargo build`, the Python packages' distributions with `uv build` (the SDK's with `build-python-sdk.sh`, checked as CI does), and the Go modules with `go build`. A package nothing of has changed since it was last built here is skipped, and the summary at the end says which.
2. Publishes the npm packages to a throwaway local registry (Verdaccio), which it leaves running, for the Browser's image, the one that installs from it. A run that builds no such image starts none.
3. Builds the eight images from the same Dockerfiles the publish workflows use, tagged `ghcr.io/the-ai-alliance/semiont-<service>:local`. They are never pushed.
4. Loads the images into every container runtime on the machine, so the stack can run under any of them.
5. Builds the launcher from the working tree, as `apps/launcher/dist/semiont`.
6. Holds each cache it keeps (npm's, uv's, Go's and cargo's) to one size, and deletes the image each rebuilt one replaced, so neither grows run after run.

The Python packages' distributions are published nowhere: Verdaccio holds npm packages only, and the worker, weaver, smelter and librarian images build them from the working tree. Each `dist/` installs by path.

Two things make the stack use your build:

- **The `:local` images, named.** A knowledge base's documents in `.semiont/stack/` name the image each service runs, and the launcher pulls none tagged `:local`. Write `ghcr.io/the-ai-alliance/semiont-<service>:local` for each `image` of a Semiont service there, and set the Browser's, which is the machine's, with `semiont settings browser-image ghcr.io/the-ai-alliance/semiont-browser:local`; `semiont settings browser-image --unset` returns it to the published one. A document still naming `:latest` runs the published image, and your change is not in it.
- **The launcher you just built**, not one installed with Homebrew. The launcher and the images are released together, so a launcher from an earlier release may not match images built from your tree.

### Rebuilding one thing

```bash
./scripts/ci/local-build.sh --package typescript/react-ui --image browser   # one package, then one image
./scripts/ci/local-build.sh --packages-only --package rust                 # the Rust crates, nothing else
./scripts/ci/local-build.sh --images-only --image librarian                # one image, from the working tree
./scripts/ci/local-build.sh --help                                         # every option
```

- The Browser's image, the one Node image, installs its package from the local registry, so a change to package source reaches it only after that package is rebuilt and republished. `--images-only` skips that step: use it when the package has not changed.
- The gateway, dispatcher and archivist images compile the Rust workspace from the working tree every time, so `--images-only --image gateway` picks up a Rust change.
- The worker, weaver, smelter and librarian images are built from the working tree every time too: the Python service in `images/worker`, `images/weaver`, `images/smelter` or `images/librarian` and the Python packages it runs on, with what its `uv.lock` pins. `--images-only --image smelter` picks up a change to any of them.
- `--package` takes `<language>/<name>` (`typescript/core`, `rust/sdk`), or a language for all of its packages, and `--image` an image's name. What either names always builds, and `--force` builds everything selected; otherwise what is unchanged is skipped. An unknown name is refused with the list.

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
container run --rm -v "$PWD":/work -w /work "node:$(scripts/ci/node-version.sh)-alpine" \
  sh -c 'npm ci --include=optional && npm run build:packages'
```

For the Rust workspace, in `packages/rust`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace` are what CI runs. For the launcher, `go vet ./...` and `go test ./...` in `apps/launcher`; its suite takes minutes.

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
