# Browser

The Semiont browser is a Vite + React SPA that connects to a running knowledge-base backend. The fastest way to get one is the published container image; this section covers what to do once it's running, the alternatives, and how to verify the image you pulled.

## Container runtime — local network access

The browser container needs to reach a KB backend on your machine. The container runtime must have local network permission to do that.

- **macOS (Apple Container):** automatic on macOS 26+; no action required.
- **macOS (Docker Desktop / Podman Desktop):** containers reach the host via `host.docker.internal`. The Semiont browser auto-detects and uses it.
- **Linux:** containers can reach the host via the default bridge IP (typically `172.17.0.1`) or `--network host`.
- **Windows:** Docker Desktop / Podman handle this via WSL2; no extra step.

Full per-platform notes live in [Local network access](../system/LOCAL-SEMIONT.md#local-network-access).

## Supply-chain verification

The published image is signed with [Cosign](https://docs.sigstore.dev/cosign/overview/) build-provenance and SBOM attestations. To verify before running:

```bash
cosign verify ghcr.io/the-ai-alliance/semiont-frontend:latest \
  --certificate-identity-regexp 'https://github.com/The-AI-Alliance/semiont/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Step-by-step provenance + SBOM verification, and how to check tags / digests against a release, is in [Supply-chain verification](../system/administration/IMAGES.md#supply-chain-verification).

## Desktop app

If you'd rather not install a container runtime at all, Semiont ships a native desktop app for macOS and Linux. No container, no local-network permission to grant.

- **Download:** [GitHub releases](https://github.com/The-AI-Alliance/semiont/releases)
- **macOS Gatekeeper workaround** and per-platform install notes: [apps/desktop/README.md](../../apps/desktop/README.md)

## Connecting the browser to a knowledge base

Once the browser is up at `http://localhost:3000`, open the **Knowledge Bases** panel and enter:

- **Host:** `localhost`
- **Port:** `4000` (the default backend port)
- **Email** and **password** as configured when starting the backend

If you don't have a backend running yet, clone one of the [knowledge base repos](https://github.com/The-AI-Alliance/semiont-template-kb) listed in the top-level README and follow its setup script.

## Running locally — both install paths

The container-image flow at the top of this page is the fastest path. **[LOCAL.md](LOCAL.md)** covers both install options end-to-end: container (no npm required) and the npm-based source build for contributors who want a hot-reload dev server.

## Other browser-persona docs

- **[FEATURES.md](FEATURES.md)** — user-facing feature tour: document management, annotations, search, AI-assisted detection.
- **[ACCESSIBILITY.md](ACCESSIBILITY.md)** — WCAG 2.1 Level AA capability claim, screen reader support, accessibility testing.
- **[KEYBOARD-NAV.md](KEYBOARD-NAV.md)** — keyboard shortcuts and the navigation model.

For frontend implementation details (architecture, component library, integration patterns) see **[apps/frontend/docs/](../../apps/frontend/docs/)** — that folder is contributor-facing.
