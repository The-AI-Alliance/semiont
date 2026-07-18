# Local Browser Setup

Run the Semiont Browser locally. The browser is a static SPA that connects to a running backend. For the broader browser-persona docs (running it as an end user, accessibility, shortcuts, features), see **[README.md](README.md)**.

## Container (no npm required)

Run the published browser image directly (substitute `docker` or `podman` for `container` as needed):

```bash
container run --publish 3000:3000 -it ghcr.io/the-ai-alliance/semiont-frontend:latest
```

The image is a static-file server with no backend config — the SPA connects
to knowledge bases from the browser at runtime. To verify the image's
provenance before running, see
[Supply-chain verification](../system/administration/IMAGES.md#supply-chain-verification).

A KB's `semiont start` (the brew-installed launcher) also starts this same
frontend container as part of the full stack (see
[Local Backend Setup](../system/LOCAL-BACKEND.md)) — the standalone
`container run` is for pointing a browser at an already-running KB.

## npm

```bash
npm install -g @semiont/cli
semiont init
semiont provision --service frontend
semiont start --service frontend
```

### Prerequisites

- **Node.js 20+** — [nodejs.org](https://nodejs.org/)
- **Backend running** at http://localhost:4000

### Service management

```bash
semiont start --service frontend
semiont stop --service frontend
semiont check --service frontend
```

### Logs

```bash
tail -f ~/.local/state/semiont/frontend/app.log
```

## Desktop App

The frontend is also available as a native desktop application (macOS, Linux). See [apps/desktop/README.md](../../apps/desktop/README.md) for download links, per-platform install notes, and the macOS Gatekeeper workaround.

## Connecting to a backend

Open **http://localhost:3000** and enter the backend URL (e.g. **http://localhost:4000**) in the connection form.

| Service | Port | URL |
|---------|------|-----|
| Frontend | 3000 | http://localhost:3000 |

## Paths

| Path | Contents |
|------|----------|
| `~/.local/state/semiont/frontend/` | Frontend log files |
| `$XDG_RUNTIME_DIR/semiont/frontend/` | Frontend PID file |
