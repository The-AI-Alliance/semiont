# Semiont Desktop

Semiont Desktop is the Electron chat client for Semiont knowledge bases. Add the URL of an
existing knowledge base gateway, sign in through its issuer in your system browser, then
browse resources and work with them in chat. The app is a client; it does not run a gateway
or keep a copy of the knowledge base.

The [Semiont Browser](../../images/browser/) is a separate web app. Desktop has its own chat
interface and stores its local configuration, preferences, chat history, and sign-in
sessions on this computer. See [DESKTOP.md](./DESKTOP.md) for its storage and security
details.

## Install

The [`publish-desktop.yml`](../../.github/workflows/publish-desktop.yml) workflow attaches
installers to Semiont's [GitHub Releases](https://github.com/The-AI-Alliance/semiont/releases).
It builds these targets:

- **macOS Apple Silicon:** unsigned `.dmg`. Open the disk image and move Semiont Desktop to
  Applications. Because the app is unsigned, macOS may ask you to confirm its first launch.
- **Linux x64:** `.deb` for Debian-based systems. The package declares Electron's required
  system libraries. Package creation has been verified; installation and launch on a Linux
  host still need verification, so treat this artifact as experimental. To install a
  published package, run `sudo apt install ./semiont-desktop_*_amd64.deb`.

Other macOS architectures, Linux ARM64, RPM, and AppImage packages are not produced.

## Connect to a knowledge base

1. Choose **Add a knowledge base** in the left sidebar and enter the gateway URL. For a
   local knowledge base, the default is `http://localhost:4000`.
2. Choose **Connect**. Desktop opens the knowledge base's issuer in your system browser to
   sign in; the session is stored locally for that knowledge base.
3. Return to Desktop to browse resources and start or continue chats.

Any knowledge base gateway reachable from this computer can be added. The app does not
create accounts or start knowledge base services.

## Develop

From the monorepo root, run the renderer's Vite server in Apple Container:

```sh
NODE_IMAGE="node:$(packages/typescript/scripts/node-version.sh)-alpine"
container run --rm -v "$PWD":/workspace -w /workspace -p 5173:5173 "$NODE_IMAGE" sh -lc \
  'npm ci && npm run build:packages -- @semiont/react-ui @semiont/sdk && npm run dev --workspace=semiont-desktop -- --host 0.0.0.0'
```

Open `http://localhost:5173` in a browser to work on the renderer. In this mode, Desktop's
Electron sign-in and file storage bridges are absent; the app uses its browser fallbacks.
The command installs dependencies and builds the workspace packages in Apple Container.

## Build installers

Run these from the monorepo root with a container runtime. macOS packaging requires a Mac; Linux packaging supports Linux and macOS hosts:

```sh
make desktop-macos            # unsigned macOS Apple Silicon DMG
make desktop-linux   # Linux x64 Debian package
```

Both builds install dependencies and run npm inside the selected container runtime; Linux packaging also supports a Linux host. `make desktop` selects the caller OS. The macOS build uses a
native `hdiutil` on the host for the DMG step; app assembly stays in the Node container; the
Linux build uses an amd64 Debian container (Rosetta on Apple Silicon). Installers are
written to `apps/desktop/release/`. Linux host installation and launch have not yet been
verified.
