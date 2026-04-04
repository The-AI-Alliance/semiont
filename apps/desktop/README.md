# Semiont Desktop

Native desktop application wrapping the Semiont frontend SPA using [Tauri](https://tauri.app/).

## Prerequisites

For local development (without containers):
- [Rust](https://rustup.rs/)
- Xcode Command Line Tools (macOS)
- Tauri CLI: `cargo install tauri-cli`

For containerized builds: just a container runtime (Apple Container, Docker, or Podman).

## Development

Start the frontend dev server in one terminal, then the desktop shell in another:

```bash
# Terminal 1: frontend
cd apps/frontend && npm run dev

# Terminal 2: desktop
cd apps/desktop && cargo tauri dev
```

The desktop app opens a native window pointing at the Vite dev server.
Hot reload works — changes to the frontend are reflected immediately.

## Build

### Containerized (no Rust on host)

```bash
apps/desktop/build.sh
```

### Local (Rust required)

```bash
cd apps/frontend && npm run build
cd apps/desktop && cargo tauri build
```

Output: `src-tauri/target/release/bundle/dmg/Semiont_x.y.z_aarch64.dmg`

## Architecture

The desktop app is a thin native shell around `apps/frontend/dist/`. No frontend
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
