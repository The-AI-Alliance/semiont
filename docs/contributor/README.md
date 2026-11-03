# Contributing to Semiont

[![CI](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml?query=branch%3Amain)

Start with [CONTRIBUTING.md](../../CONTRIBUTING.md) for branches, pull requests and review.
The [architecture](../architecture/README.md) explains the system; the
[protocol](../../protocol/README.md) defines what its implementations agree on.

## Build with Make

The root [Makefile](../../Makefile) is the public command menu for this monorepo:

```sh
make help
make local-build
make packages PACKAGE_NAMES=typescript
make check-generated
```

Make calls owner helpers that select work from manifests and content signatures and run
language tools in containers. The helpers own build ordering, caching and cleanup. Run one
operation per invocation; Make's parallel scheduler does not orchestrate the build.

The host needs GNU Make 3.81 or newer, Bash, Git, curl and a container runtime
(Apple `container`, Docker or Podman). `make local-build` builds local images and the host
launcher; [Local Development](LOCAL-DEVELOPMENT.md) explains how to run a stack on them.
Use `make generate` to update generated code intentionally, and `make check-generated` to
check committed output without repairing it.

## Find the details

| Guide | What it covers |
|---|---|
| [Local Development](LOCAL-DEVELOPMENT.md) | Host setup, container toolchains and the edit/build/run loop |
| [Local build commands](../../images/LOCAL-BUILD.md) | Selection, local npm publication, codegen, launcher and desktop targets |
| [Testing](TESTING.md) | Suites, test doubles and CI gates |
| [Packages](../../packages/README.md), [images](../../images/README.md), [apps](../../apps/README.md) | Code locations and owner documentation; adding a package |
| [Adding a job](ADDING-A-JOB.md) | Spec, SDK, service and test changes for a new job kind |
| [Dependencies](DEPENDENCIES.md) | Lockfiles, dependency updates and vulnerability fixes |
| [Documentation](DOCUMENTATION.md) | Editing builder docs and SDK examples |
| [Release](RELEASE.md) | Publishing and release verification |
