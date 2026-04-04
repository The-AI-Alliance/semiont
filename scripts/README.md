# Semiont Scripts

```
scripts/
├── ci/           Build and publish (GitHub Actions + local containers)
├── release/      Version management (runs on host — jq + git only)
├── dev/        Dev-time build helpers (requires npm)
├── lint/         Stylelint plugins and CSS checks
├── compliance/   Architecture compliance audits
└── container/    Container image management
```

Each subdirectory has its own README with detailed usage.

**Local development without npm?** See [ci/README.md](ci/README.md) — `local-build.sh`
builds and publishes all packages to a local Verdaccio registry inside containers.
