# Local Browser Setup

Run the Semiont Browser locally. The browser is a static SPA that connects to a running backend. For the broader browser-persona docs (running it as an end user, accessibility, shortcuts, features), see **[README.md](README.md)**.

## Container

Run the published browser image directly (substitute `docker` or `podman` for `container` as needed):

```bash
container run --publish 3000:3000 -it ghcr.io/the-ai-alliance/semiont-browser:latest
```

The image is a static-file server with no backend config — the SPA connects
to knowledge bases from the browser at runtime. To verify the image's
provenance before running, see
[Supply-chain verification](../system/administration/IMAGES.md#supply-chain-verification).

A KB's `semiont start` (the brew-installed launcher) also starts this same
Browser container as part of the full stack (see
[Local Backend Setup](../system/LOCAL-BACKEND.md)) — the standalone
`container run` is for pointing a browser at an already-running KB.

## Desktop App

The Browser is also available as a native desktop application (macOS, Linux). See [apps/desktop/README.md](../../apps/desktop/README.md) for download links, per-platform install notes, and the macOS Gatekeeper workaround.

## Connecting to a backend

Open **http://localhost:3000** and enter the backend URL (e.g. **http://localhost:4000**) in the connection form.

| Service | Port | URL |
|---------|------|-----|
| Browser | 3000 | http://localhost:3000 |

## Logs

The Browser container logs to stdout — `semiont logs --service browser` from a KB directory, or
your container engine's `logs` command for a standalone `container run`.
