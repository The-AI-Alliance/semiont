# Semiont Desktop

Semiont Desktop is the native Semiont chat client. It is a Vite and React app wrapped in
Electron, built from the chat UI in this workspace. The Semiont Browser remains a separate
web application in [`images/browser`](../../images/browser/).

The client connects to existing knowledge base gateways through `@semiont/sdk`. It does
not embed a gateway or store knowledge base data. Local configuration, chat history,
preferences, and sign-in sessions remain on the user's computer.

## Develop

For renderer work, install dependencies and build the two workspace package trees in Apple
Container, then start Vite there:

```sh
NODE_IMAGE="node:$(scripts/ci/node-version.sh)-alpine"
container run --rm -v "$PWD":/workspace -w /workspace -p 5173:5173 "$NODE_IMAGE" sh -c \
  'npm ci && npm run build:packages -- @semiont/react-ui @semiont/sdk && npm run dev --workspace=semiont-desktop -- --host 0.0.0.0'
```

The server is available at `http://localhost:5173`. A browser can exercise the renderer;
sign-in and file-backed persistence require the Electron shell.

## Build for macOS

The supported local package target is an **unsigned Apple Silicon DMG**. It requires macOS,
Apple Container, `curl`, `shasum`, and `tar`; the build script does not require host Node or
npm. Run:

```sh
apps/desktop/build.sh
```

The script installs and compiles the npm workspace in Apple Container, then uses a temporary,
checksum-verified Node binary to run Electron Builder on macOS. It writes the DMG under
`apps/desktop/release/`. On first launch, macOS may require opening the app from Finder's
context menu because the build is unsigned.

## Build for Linux

The supported Linux package target is an **x64 Debian package** (`.deb`). The build runs in
an amd64 Debian container under Apple Container; on Apple Silicon this uses Rosetta. Run:

```sh
apps/desktop/build.sh --linux
```

The package is written under `apps/desktop/release/`. It declares the GTK, NSS, ALSA, and
graphics libraries used by Electron as system dependencies. This target has been packaged
in the container but still needs installation and launch verification on a Debian or Ubuntu
host before release support is considered complete. RPM, AppImage, and Linux ARM64 packages
are not produced.

## User data

Desktop files live in `$XDG_CONFIG_HOME/semiont-desktop` (default `~/.config/semiont-desktop`):
the knowledge base list, one token file per knowledge base, chat history, preferences, and
diagnostic log. The app migrates files from the previous
`document-grounded-chat` directory without overwriting files already at the new location.
Config and token files are written with owner-only permissions.

## Architecture

- `src/` — the chat UI and Semiont SDK-backed workflows.
- `electron/main.ts` and `electron/preload.ts` — native window, safe IPC bridges, sign-in,
  and user-data files.
- `scripts/build-electron.mjs` — bundles Electron main and preload to CommonJS.
- `vite.config.ts` and `app.toml` — renderer build and build-time product title.
- `electron-builder.yml` and `build.sh` — product identity and macOS/Linux x64 package entry.

See [DESKTOP.md](./DESKTOP.md) for persistence, security boundaries, and the data migration.
