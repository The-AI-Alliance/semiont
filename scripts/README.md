# Semiont Scripts

```
scripts/
├── ci/                  CI/CD pipeline (portable — GitHub Actions + local containers)
│   └── publish-npm-apps.mjs
│
├── release/             Release lifecycle (runs on host — requires jq + git, not npm)
│   ├── version-bump.sh
│   └── version.mjs
│
├── build/               Local dev build utilities (run inside repo with npm)
│   ├── build-packages.js
│   └── build-css-with-sourcemaps.js
│
├── lint/                Linting and style enforcement (referenced by config files)
│   ├── check-css-invariants.sh
│   ├── check-no-utility-classes-in-react-ui.js
│   ├── stylelint-plugin-accessibility.js
│   ├── stylelint-plugin-semiont-invariants.js
│   └── stylelint-plugin-theme-selectors.js
│
├── compliance/          Compliance audits
│   ├── audit-all-compliance.sh
│   └── ...
│
└── container/           Container runtime utilities
    ├── build-images.js
    └── container-utils.js
```

## ci/

Scripts called by GitHub Actions workflows and local container builds. These are the
portable core — they run identically in CI and in a local `node:24-alpine` container.

## release/

Version management scripts. `version-bump.sh` runs on the host with just `jq` and `git`
(no npm required). `version.mjs` provides `show`, `sync`, and `set` subcommands for
contributors with npm installed.

## build/

Dev-time build helpers. Run inside the repo with npm available.

## lint/

Stylelint plugins and CSS checks. Referenced by `.stylelintrc.json` — not called directly.

## compliance/

Architecture compliance audits. Run via `npm run audit:compliance` in individual packages.

## container/

Container image build and management utilities. Auto-detects Apple Container, Docker, or Podman (in that order). Override with `CONTAINER_RUNTIME=docker` (or `podman`).

```bash
npm run container:build           # Build all images
npm run container:build:backend   # Build backend only
npm run container:build:frontend  # Build frontend only
npm run container:images          # List semiont images
npm run container:clean           # Remove semiont images
```

Prefix with `docker:` or `podman:` to force a specific runtime, or set `CONTAINER_RUNTIME`.
