# semiont-browser

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=image-browser)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)
[![npm version](https://img.shields.io/npm/v/@semiont/browser.svg)](https://www.npmjs.com/package/@semiont/browser)
[![ghcr](https://img.shields.io/badge/ghcr-semiont--browser-blue)](https://github.com/The-AI-Alliance/semiont/pkgs/container/semiont-browser)

**The Browser is the human entry point to Semiont**: a single-page app (SPA) for browsing,
annotating and generating resources in a knowledge base, written in TypeScript with React and
Vite. The `semiont` launcher starts it on `semiont start`, as the container `semiont-browser`,
which serves the pre-built SPA on port 3000.

| | |
| --- | --- |
| Image | `ghcr.io/the-ai-alliance/semiont-browser` |
| Port | 3000 |
| Command | `node /app/node_modules/@semiont/browser/server.js`, under `tini` |
| Code | TypeScript, in this directory: [src](./src) |
| Published | npm, as [@semiont/browser](https://www.npmjs.com/package/@semiont/browser), which the image installs |

## What it does

**It is a client and nothing more.** It stores no data, owns no schema and has no backend of
its own: everything it displays comes from a knowledge base it has connected to. This app is
the shell, and the few components that belong nowhere else (the Knowledge Bases panel,
navigation, toolbar wiring).

| Part | Owns |
|---|---|
| `@semiont/react-ui` | the annotation UI itself: components, panels, state units |
| `@semiont/sdk` | every knowledge-base operation |
| this app | routes, i18n, providers, page assembly |

**It contains no `fetch` calls at all.** The Browser never reaches an API directly; it goes
through the SDK. This app is a fraction the size of `react-ui`.

Its route surfaces each sit under a locale prefix:

- `know/`: discover, compose, and a resource's page, where it is browsed and annotated
- `moderate/`: recent resources, entity tags, tag schemas
- `auth/`: connect, the issuer's callback, and the sign-in error page

`server.js`, a static file server, serves the SPA: files out of `dist/` and the `/discovery`
prefix, each behind a directory-traversal guard, and SPA fallback to `index.html` for
non-file routes.

## What it talks to

- **The [gateway](../gateway/) of each knowledge base it connects to**, through `@semiont/sdk`.
- **The issuer of each knowledge base**, its sign-in provider, to sign in and to sign out.
- **The launcher's discovery document**, from the Browser's own `server.js`, under `/discovery/`.
- **An OTLP endpoint**, for its OpenTelemetry traces, when the bundle is built with one.

## Knowledge bases are a runtime choice

The Browser holds a registry of knowledge bases and activates one at a time, with its own
session and its own sign-in per knowledge base. A person adds one in the Knowledge Bases
panel; no operator configures it.

**`/discovery/*` returns its file or a 404, never `index.html`.** `server.js` serves the prefix
from a read-only directory the launcher mounts, so the app can offer the knowledge bases
already running on the machine. A 200 carrying the SPA would be indistinguishable from data.

## When it starts

**It belongs to no stack.** Every `semiont start` keeps a running Browser whose image is
current, and replaces one whose image is not. `semiont stop` stops it with the stack;
`semiont stop --service browser` stops it alone. Its command,
`node /app/node_modules/@semiont/browser/server.js`, runs under a `tini` entrypoint.

## Configuration

Almost none, deliberately.

| Setting | Read at | What it is |
|---|---|---|
| `PORT` | runtime | the port `server.js` listens on (default `3000`). In the image it stays `3000`, where its health check and its supervisor's probe look; the launcher publishes the port the Browser's document names (`spec.port`) onto it |
| `/discovery` | runtime | the read-only mount for the launcher's discovery document |
| `VITE_OTEL_OTLP_ENDPOINT` | build time | the OTLP endpoint, baked into the bundle |

**`VITE_` values are compile-time substitutions.** Changing one needs a rebuild, not a restart.

## What the image carries

Node and the npm package `@semiont/browser`: the built `dist/` plus `server.js`, with no
runtime dependencies. The image does not build the SPA; its first stage installs the
published package from an npm registry. npm is removed from the runtime image. One build,
three consumers: this image, the package `@semiont/browser` itself, and
[`apps/desktop`](../../apps/desktop/), which uses this app's `dist/` as its Tauri frontend.

## Working on it

```bash
npm run dev          # Vite dev server; connect it to a running stack's gateway in the app
npm run build        # copy favicons and pdf.js wasm, typecheck, then vite build
npm run typecheck    # tsc --noEmit
npm test             # vitest
npm run test:a11y    # accessibility suite
```

**Translations are generated: edit `messages-source/`, never `messages/`.** `messages-source/`
holds this app's strings; [`scripts/merge-translations.js`](./scripts/merge-translations.js)
merges them with `@semiont/react-ui`'s on the `pre*` hooks and writes `messages/` and
`public/messages/`, both untracked.

## Building it

The image does not build the app: it installs a published `@semiont/browser` from an npm
registry, `NPM_REGISTRY` (npm's own by default), at the version `SEMIONT_BROWSER_VERSION`
(`latest` by default). [`scripts/ci/local-build.sh`](../../scripts/ci/local-build.sh) builds
this directory's package, publishes it to the Verdaccio it starts, and builds the image
against that registry, tagged `ghcr.io/the-ai-alliance/semiont-browser:local`;
[`publish-browser.yml`](../../.github/workflows/publish-browser.yml) builds it from the
published package.

## Related

- [Human UI](../../docs/architecture/HUMAN-UI.md) — how the Browser fits the rest of Semiont
- [The analyst's guide](../../docs/analyst/README.md) — working in it
- This app's documents: [Architecture](./docs/ARCHITECTURE.md) · [Development](./docs/DEVELOPMENT.md) ·
  [Container](./docs/CONTAINER.md) · [Deployment](./docs/DEPLOYMENT.md) · [Testing](./docs/TESTING.md) ·
  [Authentication](./docs/AUTHENTICATION.md) · [Internationalization](./docs/INTERNATIONALIZATION.md) ·
  [Accessibility](./docs/ACCESSIBILITY.md); the full set is in [`docs/`](./docs/)
