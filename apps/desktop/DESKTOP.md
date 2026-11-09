# Desktop application architecture

Semiont wraps its own chat renderer in Electron. It is a separate client from the
Semiont Browser, which remains a web app. The renderer uses `@semiont/sdk` and
`@semiont/react-ui`; it does not call gateway APIs directly.

## Native boundaries

- Electron's renderer runs with context isolation and without Node integration.
- `electron/preload.ts` exposes narrow IPC bridges for configuration, history, preferences,
  window sizing, sign-in, launcher commands, and local machine checks.
- The main process signs users in through their knowledge base issuer in the system browser.
  It keeps access and refresh tokens in per-KB files with owner-only permissions.
- HTTP(S) links opened by the renderer go to the user's default browser.
- The bundled `semiont` launcher runs `status` and `about` when the user opens those views.
  The Telemetry and Container runtime views currently read those human-readable reports;
  a versioned launcher machine API has not been added yet. Git, Ollama, and 1Password CLI
  checks inspect the local machine from Electron's main process.
- The MCP menu can start and stop a Desktop-managed `semiont mcp` stdio process and show its
  PID, elapsed time, resident memory, and average CPU use. This process is not an MCP endpoint
  for other applications; they start their own launcher process or use the Semiont SDK.

## Persistent state

The user data directory is `$XDG_CONFIG_HOME/semiont-desktop`, or
`~/.config/semiont-desktop` when `XDG_CONFIG_HOME` is unset. It contains `config.toml`,
`history.json`, `prefs.json`, `sessions/`, and `log.txt`. Sensitive config and session files
are created with mode `0600`; the directory is mode `0700`.

On first launch after upgrading from Document-Grounded Chat, the app moves
`document-grounded-chat` to `semiont-desktop` when the destination does not exist. If both
locations exist, it copies only files absent from the destination and leaves the old files
in place. Web localStorage keys are also read from their old names and moved to the new key
on the next write.

## Build and support

`apps/desktop/build.sh` is the local build entry. `make desktop` selects the host target:
an unsigned Apple Silicon DMG on macOS, or a Linux x64 Debian package on Linux. The explicit
targets are `make desktop-macos`, `make desktop-macos-app`, `make desktop-macos-dmg`, and
`make desktop-linux`. The macOS app and Linux package are assembled in containers; npm
commands run inside the container runtime selected by the build (Apple Container, Docker,
or Podman). Creating the DMG uses macOS `hdiutil` and therefore requires a Mac, but the
macOS app itself can be assembled on another supported host. On Apple Silicon, the Linux
package is built in an amd64 Debian container using Rosetta.

Installers are written under `apps/desktop/release/`. Each bundles a statically built
`semiont` launcher for its target platform at the app's `Resources/launcher/semiont` (macOS)
or `resources/launcher/semiont` (Linux) path. The build derives the Go toolchain from
`apps/launcher/go.mod`. Desktop runs it as `semiont control` and speaks the launcher's
control API to it (`protocol/contract/LAUNCHER-CONTROL.md`). `electron-builder.yml` carries
the Semiont product name and bundle identifier. The Linux `.deb` package build has been
exercised, but installation and launch on a Debian or Ubuntu host still need verification;
treat that artifact as experimental.
