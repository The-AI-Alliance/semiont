# Local development

Local development is built around **[`make local-build`](../../Makefile)**. It builds your working tree into the real service images, and the launcher runs those. What you test is what ships.

## What you need

- **Host tools**: GNU Make 3.81 or newer, Bash, Git, curl, and Apple `container`, Docker or Podman. Language toolchains run in containers.
- **A knowledge base to run against.** Clone [`semiont-template-kb`](https://github.com/The-AI-Alliance/semiont-template-kb), or see [Knowledge Bases](../KNOWLEDGE-BASES.md) for others.

## Container toolchains

The local Make commands obtain Node, Rust, Go, Python build environments, .NET, JDK/Gradle
and Swift from containers. Their manifests and toolchain readers own the versions; do not
install those SDKs on the host for this workflow. Python metadata helpers run in a disposable container owned by each operation. Host Python and Node are not required.
macOS desktop packaging also uses the operating system's `hdiutil` and `PlistBuddy`, with app
assembly performed in the Node container.

## The loop

```bash
# 1. In the repository: build the packages, all eight images, the launcher, and the Python SDK
make local-build

# 2. In the knowledge base: run the stack on what you built. Name the :local
#    images in .semiont/stack/*.yaml (ghcr.io/the-ai-alliance/semiont-gateway:local,
#    and so on for each service), and the Browser's and the worker's in their
#    own documents
cd /path/to/your-kb
perl -pi -e 's#(semiont-browser):\S+#$1:local#' "$(/path/to/semiont/apps/launcher/dist/semiont settings browser --path)"
perl -pi -e 's#(semiont-worker):\S+#$1:local#' "$(/path/to/semiont/apps/launcher/dist/semiont settings worker --path)"
/path/to/semiont/apps/launcher/dist/semiont start
/path/to/semiont/apps/launcher/dist/semiont useradd --email you@example.com

# 3. Change code, then rebuild only what changed (below) and start again

# 4. When you are done
/path/to/semiont/apps/launcher/dist/semiont stop
container stop semiont-verdaccio
```

What a full run does:

1. Builds every package of `packages/<language>/<name>`, each in its language's container: the npm packages in the order [`version.json`](../../version.json) lists them, the Rust crates with `cargo build`, the Python packages' distributions with `uv build` (the SDK's with `build-python-sdk.sh`, checked as CI does), the Go modules with `go build`, and the Kotlin SDK with its Gradle wrapper. A package nothing of has changed since it was last built here is skipped, and the summary at the end says which.
2. Publishes the npm packages to a throwaway local registry (Verdaccio), which it leaves running, for the Browser's image, the one that installs from it. A run that builds no such image starts none.
3. Builds the eight images from the same Dockerfiles the publish workflows use, tagged `ghcr.io/the-ai-alliance/semiont-<service>:local`. They are never pushed.
4. Loads the images into every container runtime on the machine, so the stack can run under any of them.
5. Builds the launcher from the working tree, as `apps/launcher/dist/semiont`.
6. Holds each cache it keeps (npm's, uv's, Go's and cargo's) to one size, and deletes the image each rebuilt one replaced, so neither grows run after run.

The Python packages' distributions are published nowhere: Verdaccio holds npm packages only, and the worker, weaver, smelter and librarian images build them from the working tree. Each `dist/` installs by path.

Two things make the stack use your build:

- **The `:local` images, named.** A knowledge base's documents in `.semiont/stack/` name the image each service runs, and the launcher pulls none tagged `:local`. Write `ghcr.io/the-ai-alliance/semiont-<service>:local` for each `image` of a Semiont service there, and the Browser's and the worker's, which are shared, as the image in each one's own document, the file `semiont settings browser --path` or `semiont settings worker --path` prints; `:latest` there returns it to the published one. A document still naming `:latest` runs the published image, and your change is not in it.
- **The launcher you just built**, not one installed with Homebrew. The launcher and the images are released together, so a launcher from an earlier release may not match images built from your tree.

### Rebuilding one thing

```bash
make local-build PACKAGE_NAMES=typescript/react-ui IMAGE_NAMES=browser   # one package, then one image
make packages  PACKAGE_NAMES=rust                 # the Rust crates, nothing else
make images-only  IMAGE_NAMES=librarian                # one image, from the working tree
make help                                          # every option
```

- The Browser's image, the one Node image, installs its package from the local registry, so a change to package source reaches it only after that package is rebuilt and republished. `make images-only` skips that step: use it when the package has not changed.
- The gateway, dispatcher and archivist images compile the Rust workspace from the working tree every time, so `make images-only IMAGE_NAMES=gateway` picks up a Rust change.
- The worker, weaver, smelter and librarian images are built from the working tree every time too: the Python service in `images/worker`, `images/weaver`, `images/smelter` or `images/librarian` and the Python packages it runs on, with what its `uv.lock` pins. `make images-only IMAGE_NAMES=smelter` picks up a change to any of them.
- `PACKAGE_NAMES` takes `<language>/<name>` (`typescript/core`, `rust/sdk`), or a language for all of its packages, and `IMAGE_NAMES` an image's name. What either names always builds, and `FORCE=1` builds everything selected; otherwise what is unchanged is skipped. An unknown name is refused with the list.

The script's own README, [images/LOCAL-BUILD.md](../../images/LOCAL-BUILD.md), covers the rest.

## Working on one package, without a stack

Most changes do not need a running stack. Build packages with Make:

```bash
make packages PACKAGE_NAMES=typescript
make packages PACKAGE_NAMES=rust
```

For a focused TypeScript check, run the workspace command inside its tool container:

```bash
container run --rm -v "$PWD":/work -w /work "node:$(packages/typescript/scripts/node-version.sh)-alpine" \
  sh -c 'npm ci --include=optional && npm run build:packages && npm test --workspace=@semiont/sdk'
```

Use `docker` or `podman` in place of `container` when that is your runtime.

[Testing](TESTING.md) has every suite, what each needs, and how to run it in a container.

## Looking at a running stack

The launcher's verbs work the same on a stack built from source:

```bash
semiont status                     # each service's state and health
semiont logs --service worker      # follow one service
semiont start --service worker     # restart one after rebuilding its image
```

In the Browser's console, `window.__SEMIONT_BUS_LOG__ = true` logs one line for every bus event that page sends and receives, which is often the fastest way to see what a change did: see [Bus logging](../../images/e2e/docs/bus-logging.md). Every service's traces are at `http://localhost:16686` ([Observability](../operator/administration/OBSERVABILITY.md)).

## Related

- [images/LOCAL-BUILD.md](../../images/LOCAL-BUILD.md): `make local-build` and the build and publish scripts
- [Testing](TESTING.md): the suites and how to run them
- [The service catalog](../operator/services/OVERVIEW.md): what is running, and on which ports
- [Running knowledge bases on your computer](../operator/LOCAL-SEMIONT.md): the launcher from an operator's side
- [Troubleshooting](../operator/administration/TROUBLESHOOTING.md): when a start fails or a service is unhealthy
