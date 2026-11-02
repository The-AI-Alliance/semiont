# Semiont Desktop: replace the browser shell with the chat app

## Goal

Replace the current Tauri shell around `images/browser` with the Electron-based chat app from `gh.c/adampingel/chat`, adapted as the Semiont monorepo's `apps/desktop`. The installed product and all first-party branding should say **Semiont Desktop**. Keep the existing browser app intact. Provide a documented macOS build and Linux x64 Debian package path through Apple Container.

## Current constraints

- `apps/desktop` is already a Tauri application and is included in the release workflow for macOS and Linux. Replacing it means updating its app source, docs, CI/release packaging, and references; simply copying files would leave conflicting build systems.
- The chat app currently identifies its package as `my-chat`, its Electron bundle as `org.pingel.document-grounded-chat`, and its author as Pingel. The product name is `Document-Grounded Chat`.
- The chat app keeps user config, KB sessions, chat history, preferences, and logs under `~/.config/document-grounded-chat` (or `$XDG_CONFIG_HOME`). A rename must preserve existing users' data.
- The chat checkout uses a local Verdaccio registry and registry-drift script for `@semiont/*`. The monorepo owns these packages as npm workspaces, so the migrated app must use the monorepo workspace packages and lockfile instead.
- The existing Tauri release workflow produces macOS and Linux artifacts. Electron support is scoped to macOS ARM64 and Linux x64 Debian packages; Linux installation and launch still need host verification.

## Work plan

1. **Replace the app source and build identity**
   - Move the chat app's renderer, Electron main/preload code, app configuration, and assets into `apps/desktop`.
   - Remove the Tauri Rust project, Tauri builder image, and Tauri-only scripts/configuration after their replacement paths are in place.
   - Rename the npm workspace/package to `semiont-desktop`; set the product, app/window title, installer name, and app identifier for Semiont Desktop under The AI Alliance namespace. Remove Pingel-specific package and bundle metadata.
   - Keep the existing chat UI and SDK-backed flows; do not fork or copy the Browser SPA into this app.

2. **Integrate with the monorepo**
   - Use the root npm workspace and lockfile, with local `@semiont/core`, `@semiont/react-ui`, and `@semiont/sdk` workspace dependencies.
   - Remove the app's Verdaccio-only install/drift assumptions, hard-coded container host mapping, and standalone lockfile assumptions.
   - Update root scripts/workspace behavior and app docs so development, typechecking, and packaging work from the monorepo.

3. **Preserve user data across the rename**
   - Define the canonical Semiont Desktop config directory and migrate the old `document-grounded-chat` directory safely on first launch.
   - Preserve restrictive file/directory permissions for tokens and conversation data; do not overwrite existing destination files during migration.
   - Keep web localStorage keys and desktop persistence behavior intentional and documented.

4. **Put macOS and Linux build paths in place**
   - Add a repo-root-aware `apps/desktop/build.sh` and package scripts for development, typecheck, renderer/main compilation, and packaging.
   - Build an Apple Silicon DMG and a Linux x64 `.deb` in Apple Container without requiring a private registry.
   - Document prerequisites, invocation, output location, signing status, runtime dependencies, and the exact current platform/architecture support.

5. **Update release and app documentation**
   - Replace Tauri-specific release workflow steps with Electron packaging for macOS ARM64 and Linux x64 `.deb`, preserving the existing release opt-in and artifact naming conventions where practical.
   - Update `apps/README.md` and `apps/desktop/README.md` to describe Semiont Desktop as the chat client and explain how it differs from the Browser.
   - Remove stale Tauri and old product-name references that no longer describe the shipped desktop app.

6. **Limit and verify Linux support**
   - Build the x64 `.deb` in an amd64 Debian container; document its Debian/Ubuntu runtime library dependencies.
   - Add the Linux artifact to release CI.
   - Verify installation and launch on a Debian or Ubuntu host before describing Linux support as complete. RPM, AppImage, ARM64, and other distributions remain out of scope.

## Completion checks

- The app is a root npm workspace named `semiont-desktop`; workspace dependencies resolve from this monorepo.
- No Pingel identity, Verdaccio-only install path, or Tauri build path remains in the replacement app's active packaging configuration.
- Existing `document-grounded-chat` user data is preserved and available after first launch under the Semiont Desktop identity.
- The macOS build script and documentation produce the expected ARM64 DMG from the monorepo checkout.
- The Linux build script produces an x64 `.deb` in Apple Container and release workflow/docs list that target accurately.
- Linux installation and launch are verified on Debian or Ubuntu before calling Linux support complete.
