# Semiont Desktop

Native desktop application wrapping the Semiont browser SPA using [Tauri](https://tauri.app/). It bundles the same UI as the container image with a thin native shell, so there's no container runtime to install and no local network permission to grant.

You still need a knowledge base backend running somewhere — point the app at it the same way you would the browser version.

## Install

Download the latest build for your platform from the [Releases page](https://github.com/The-AI-Alliance/semiont/releases).

### macOS

The macOS DMGs are not signed with an Apple Developer ID, so Gatekeeper quarantines them on download. Before opening the DMG, strip the quarantine attribute:

```bash
xattr -cr ~/Downloads/Semiont_*.dmg
```

Then open the DMG normally and drag Semiont.app to Applications. Without this step you'll see "Semiont is damaged and can't be opened" — that's Gatekeeper, not actual damage.

Builds are published for both Apple Silicon (`aarch64`) and Intel (`x86_64`) Macs.

### Linux

Two artifacts are published for x86_64:

- **`.deb`** — for Debian, Ubuntu, and derivatives:
  ```bash
  sudo apt install ./Semiont_*_amd64.deb
  ```
- **`.AppImage`** — portable, runs on most distributions:
  ```bash
  chmod +x Semiont_*_amd64.AppImage
  ./Semiont_*_amd64.AppImage
  ```

## Connecting to a backend

On first launch, enter the backend host and port (e.g. `localhost:4000`) in the Knowledge Bases panel. The app talks to the backend over plain HTTP — same as the browser version — so any backend reachable from your machine works.

## Building from source

The rest of this document covers developing and building the desktop app from source. Most users only need the [Install](#install) section above.

### Prerequisites

For local development (without containers):
- [Rust](https://rustup.rs/)
- Xcode Command Line Tools (macOS)
- Tauri CLI: `cargo install tauri-cli`

For containerized builds: just a container runtime (Apple Container, Docker, or Podman).

### Development

Start the frontend dev server in one terminal, then the desktop shell in another:

```bash
# Terminal 1: frontend
cd apps/frontend && npm run dev

# Terminal 2: desktop
cd apps/desktop && cargo tauri dev
```

The desktop app opens a native window pointing at the Vite dev server.
Hot reload works — changes to the browser are reflected immediately.

### Build

#### Containerized (no Rust on host)

```bash
apps/desktop/build.sh
```

#### Local (Rust required)

```bash
cd apps/frontend && npm run build
cd apps/desktop && cargo tauri build
```

Output: `src-tauri/target/release/bundle/dmg/Semiont_x.y.z_aarch64.dmg`

## Architecture

The desktop app is a thin native shell around `apps/frontend/dist/`. No browser
code lives here — this directory only contains the Tauri configuration, Rust entry
point, and build scripts.

```
apps/desktop/
├── src-tauri/
│   ├── Cargo.toml          # Rust dependencies
│   ├── tauri.conf.json     # Window config, build paths, app identity
│   ├── build.rs            # Tauri build hook
│   ├── src/
│   │   └── main.rs         # Entry point (opens window, loads SPA)
│   └── icons/              # App icons (.icns, .ico, .png)
├── build.sh                # Containerized build script
├── package.json
└── README.md
```
