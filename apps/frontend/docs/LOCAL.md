# Local Frontend Setup

Run the Semiont frontend locally. The frontend is a static SPA that connects to a running backend.

## Container (no npm required)

Clone a knowledge base repository and run the frontend script:

```bash
git clone https://github.com/The-AI-Alliance/gutenberg-kb.git
cd gutenberg-kb
.semiont/scripts/local_frontend.sh
```

The script builds and runs the frontend in a container. The backend must be running first (see [backend LOCAL.md](../../backend/docs/LOCAL.md)).

The authoritative Dockerfile and script live in the [semiont-empty-kb](https://github.com/The-AI-Alliance/semiont-empty-kb) template repository under `.semiont/`.

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

The frontend is also available as a native desktop application (macOS, Linux).
Download from the [GitHub Releases](https://github.com/The-AI-Alliance/semiont/releases) page.

**macOS note:** The app is not yet code-signed. macOS will show "damaged and can't be opened." Run this before opening:

```bash
xattr -cr ~/Downloads/Semiont_*.dmg
```

See [apps/desktop/README.md](../../desktop/README.md) for building from source.

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
