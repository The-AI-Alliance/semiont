# Desktop application architecture

Semiont wraps its own chat renderer in Electron. It is a separate client from the
Semiont Browser, which remains a web app. The renderer uses `@semiont/sdk` and
`@semiont/react-ui`; it does not call gateway APIs directly.

## Native boundaries

- Electron's renderer runs with context isolation and without Node integration.
- `electron/preload.ts` exposes narrow IPC bridges for configuration, history, preferences,
  diagnostics, window sizing, and sign-in.
- The main process signs users in through their knowledge base issuer in the system browser.
  It keeps access and refresh tokens in per-KB files with owner-only permissions.
- HTTP(S) links opened by the renderer go to the user's default browser.

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

`apps/desktop/build.sh` is the local build entry. It produces an unsigned Apple Silicon
DMG; `make desktop-linux` produces a Linux x64 Debian package. Both outputs are
written under `apps/desktop/release/`, with npm commands run inside Apple Container.
Each package includes the matching static `semiont` launcher binary at
`Resources/launcher/semiont`. The build derives its Go toolchain from
`apps/launcher/go.mod`; the desktop does not invoke the sidecar yet.
`electron-builder.yml` carries the Semiont product name and the existing Semiont
bundle identifier. The `.deb` dependency metadata and package build have been exercised;
installation and launch still need verification on a Debian or Ubuntu host.
