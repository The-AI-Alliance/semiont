# Semiont Desktop

An installable native build of the Semiont browser UI. A thin [Tauri](https://tauri.app/) shell wraps the same SPA that runs in the web build — a native window and menu around the compiled UI — so Semiont launches from the OS like any other app, no browser tab required.

The desktop build ships only the UI. It holds no data and no application logic: like the web build, it talks to a knowledge base **gateway** over HTTP, which you point it at on first launch.

## Install

Download the latest build for your platform from the [Releases page](https://github.com/The-AI-Alliance/semiont/releases).

### macOS

DMGs are published for both Apple Silicon (`aarch64`) and Intel (`x86_64`). They are not signed with an Apple Developer ID, so Gatekeeper quarantines them on download. Strip the quarantine attribute before opening:

```bash
xattr -cr ~/Downloads/Semiont_*.dmg
```

Then open the DMG and drag Semiont.app to Applications. Without this step you'll see "Semiont is damaged and can't be opened" — that's Gatekeeper, not actual damage.

### Linux

Two x86_64 artifacts are published:

- **`.deb`** — Debian, Ubuntu, and derivatives:
  ```bash
  sudo apt install ./Semiont_*_amd64.deb
  ```
- **`.AppImage`** — portable, runs on most distributions:
  ```bash
  chmod +x Semiont_*_amd64.AppImage
  ./Semiont_*_amd64.AppImage
  ```

## Connecting to a gateway

On first launch, enter the gateway host and port (e.g. `localhost:4000`) in the Knowledge Bases panel. The app talks to the gateway over plain HTTP, so any gateway reachable from your machine works.

## Building from source

Most users only need the installers above. To build locally:

### Prerequisites

- [Rust](https://rustup.rs/) and the Tauri CLI (`cargo install tauri-cli`)
- Xcode Command Line Tools (macOS)
- Or, for the containerized path: just a container runtime (Apple Container, Docker, or Podman)

### Develop

Run the browser dev server, then open the desktop shell against it:

```bash
# Terminal 1: browser UI
cd apps/browser && npm run dev

# Terminal 2: desktop shell
cd apps/desktop && cargo tauri dev
```

The window points at the Vite dev server, so hot reload works.

### Build

The bundler emits installers for the platform it runs on:

- **macOS** (Rust on host) → `.dmg`
  ```bash
  npm run build -w semiont-browser
  cd apps/desktop && cargo tauri build
  # → src-tauri/target/release/bundle/dmg/Semiont_x.y.z_aarch64.dmg
  ```
- **Linux** → `.deb` and `.AppImage`, from the same two commands on a Linux host, or without Rust via the containerized build:
  ```bash
  apps/desktop/build.sh
  # → src-tauri/target/release/bundle/{deb,appimage}/
  ```

Official multi-platform builds — both Mac architectures and Linux — come from CI and land on the Releases page.

## Architecture

A thin native shell around `apps/browser/dist/`. No UI code lives here — only the Tauri configuration, the Rust entry point, and the build scripts.

```
apps/desktop/
├── src-tauri/
│   ├── Cargo.toml          # Rust dependencies (tauri + opener)
│   ├── tauri.conf.json     # window config, bundle targets, app identity
│   ├── build.rs            # Tauri build hook
│   ├── src/main.rs         # entry point: opens the window + native menu, loads the SPA
│   └── icons/              # app icons (.icns, .ico, .png)
├── build.sh                # containerized Linux build
├── package.json
└── README.md
```
