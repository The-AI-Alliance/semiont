# Semiont Browser

[![npm version](https://img.shields.io/npm/v/@semiont/browser.svg)](https://www.npmjs.com/package/@semiont/browser)
[![ghcr](https://img.shields.io/badge/ghcr-semiont--browser-blue)](https://github.com/The-AI-Alliance/semiont/pkgs/container/semiont-browser)

The human entry point to Semiont: a React single-page app for browsing, annotating, and
generating resources in a knowledge base.

It is a client and nothing more. It stores no data, owns no schema, and has no backend of its
own — everything it displays comes from a knowledge base it has connected to. In a running
stack it is a container: the launcher starts `semiont-browser`, which serves the pre-built SPA
on port 3000.

## What this app owns

The shell, and little else — routes, locale, providers, page assembly, and the few components
that make sense nowhere else (navigation, toolbar wiring, cookie preferences).

| | |
|---|---|
| `@semiont/react-ui` | the annotation UI itself — components, panels, state units |
| `@semiont/sdk` | every knowledge-base operation |
| this app | routes, i18n, providers, page assembly |

The boundary is real, not aspirational: this app is a fraction the size of `react-ui`, and
contains **no `fetch` calls at all**. The browser never reaches an API directly; it goes
through the SDK.

Route surfaces are `know/` (browse, annotate, compose, generate), `admin/`, `moderate/`,
`auth/`, and the static `about`, `privacy` and `terms` pages.

## Knowledge bases are a runtime choice

The browser is not built against a backend. It holds a registry of knowledge bases and
activates one at a time, with its own session and its own sign-in per knowledge base. Adding
one is something a person does in the Knowledge Base panel, not something an operator
configures.

`server.js` also serves `/discovery/*` from a read-only directory the launcher mounts, so the
app can offer the knowledge bases already running on the machine. That prefix returns its file
or a 404 and never falls back to `index.html` — a 200 carrying the SPA would be
indistinguishable from data.

## How it ships

One build, three consumers:

- **Container** — `semiont-browser`, the usual case. Entrypoint `node server.js`; npm is
  removed from the runtime image.
- **npm** — `@semiont/browser`: the built `dist/` plus `server.js`, with no runtime
  dependencies.
- **Desktop** — `apps/desktop` uses this app's `dist/` as its Tauri frontend.

`server.js` is a static file server: files out of `dist/`, SPA fallback to `index.html` for
non-file routes, directory-traversal guards on both paths, and the `/discovery` prefix above.

## Configuration

Almost none, deliberately.

| | | |
|---|---|---|
| `PORT` | runtime | port `server.js` listens on (default `3000`) |
| `/discovery` | runtime | read-only mount for the launcher's KB discovery document |
| `VITE_OTEL_OTLP_ENDPOINT` | build time | OTLP endpoint, baked into the bundle |

`VITE_` values are compile-time substitutions. Changing one needs a rebuild, not a restart.

## Development

```bash
npm run dev          # Vite dev server (expects a gateway)
npm run dev:mock     # ...against a mock API instead
npm run build        # typecheck, then vite build
npm run typecheck    # tsc --noEmit
npm test             # vitest
npm run test:a11y    # accessibility suite
```

Translations are generated. `messages-source/` holds this app's strings;
`scripts/merge-translations.js` merges them with `@semiont/react-ui`'s on the `pre*` hooks and
writes `messages/` (untracked) and `public/messages/`. Edit `messages-source/`, never
`messages/`.

## Documentation

[Architecture](./docs/ARCHITECTURE.md) ·
[Development](./docs/DEVELOPMENT.md) ·
[Container](./docs/CONTAINER.md) ·
[Deployment](./docs/DEPLOYMENT.md) ·
[Testing](./docs/TESTING.md) ·
[Authentication](./docs/AUTHENTICATION.md) ·
[Internationalization](./docs/INTERNATIONALIZATION.md) ·
[Accessibility](./docs/ACCESSIBILITY.md)

The full set is in [`docs/`](./docs/).
