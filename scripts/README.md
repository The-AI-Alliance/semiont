# Semiont Scripts

```
scripts/
├── ci/           Build and publish (GitHub Actions + local containers)
├── release/      The release scripts: preflight, verify, announce, version bump
├── dev/          Dev-time build helpers (requires npm)
├── lint/         The `lint:*` gates
├── compliance/   Architecture compliance audits
├── spec/         Checks over `specs/`
└── container/    Container image management
```

Each subdirectory has its own README with detailed usage.

**Local development without npm?** See [ci/README.md](ci/README.md) — `local-build.sh`
builds and publishes all packages to a local Verdaccio registry inside containers.
