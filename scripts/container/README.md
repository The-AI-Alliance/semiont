# scripts/container — Container Images

Scripts that build Semiont's container images, run inside them, or check them.

## Building and managing images (run on the host)

| Script | Purpose |
|--------|---------|
| `build-images.js` | Builds the gateway, dispatcher and Browser images — the gateway and the dispatcher with the toolchain `rust-toolchain.toml` pins. The five Node service images are built by `scripts/ci/local-build.sh` and the image publish workflow, not here. |
| `container-utils.js` | Lists and removes semiont images. |

Both auto-detect Apple Container, Docker, or Podman (in that order). Override with
`CONTAINER_RUNTIME=docker` (or `podman`).

```bash
npm run container:build              # Build the gateway, dispatcher and Browser images
npm run container:build:gateway      # Build the gateway only
npm run container:build:dispatcher   # Build the dispatcher only
npm run container:build:browser   # Build the Browser only
npm run container:images          # List semiont images
npm run container:clean           # Remove semiont images
```

The `podman:` variants (`npm run podman:build`, …) force Podman. The `docker:`
variants are aliases of the `container:` ones and auto-detect the same way; to
force Docker, set `CONTAINER_RUNTIME=docker`.

## Inside the images

Copied into images by their Dockerfiles; the build context is the repository root.

| Script | Purpose | Images |
|--------|---------|--------|
| `boot.sh` | The entrypoint, run as PID 1 under tini. With `SEMIONT_SUPERVISE` set — the launcher sets it for local stacks — it runs the image's `CMD` under `supervise.sh`; unset, it execs the `CMD` directly, so a published image behaves like a conventional container. | all seven services and the Browser |
| `supervise.sh` | The in-container supervisor: restarts a crashed child, probes and kills a hung one, fails fast on a deterministic boot refusal instead of looping, and forwards `TERM` from `semiont stop`. | all seven services and the Browser |
| `patch-qdrant-undici.sh` | Installer-stage step. Replaces the `undici` that `@qdrant/js-client-rest` pins for itself with a patched release, because `npm install -g` ignores `overrides`. **Self-retiring:** it exits non-zero once there is nothing left to patch — when that happens, delete it and its `RUN` lines rather than loosening the check. | archivist, librarian, smelter, weaver |

## Checking a built image

| Script | Purpose |
|--------|---------|
| `check-gateway-image.sh <image> [runtime]` | Checks what a built gateway image promises: no source in it, a first `/api/health` 200 within its start bound, and its `HEALTHCHECK` passing against the serving gateway. Run by `scripts/ci/local-build.sh` and the image publish workflow. |
| `check-dispatcher-image.sh <image> [runtime]` | Checks what a built dispatcher image promises: no source and no Node in it, and, run as its `CMD` says with no document mounted, a refusal by name (exit 1, `Cannot read the dispatcher's configuration document`) within its bound. Run by `scripts/ci/local-build.sh` and the image publish workflow. |
