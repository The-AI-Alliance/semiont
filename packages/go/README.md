# Go

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=go)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

The Go SDK, and the libraries the `semiont` launcher ([apps/launcher](../../apps/launcher/README.md)) is built from.

| Module | Published | Coverage | What it is |
|---|---|---|---|
| [go/sdk](./sdk/README.md) | Not published | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=go-sdk)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components) | The Go SDK: the client of a knowledge base, its transport over a gateway, signing in, live queries, the state units, a worker's claims, and the doubles a test is built on (`semionttest`). The `semiont` launcher ([apps/launcher](../../apps/launcher/README.md)) is built on it |
| [go/launcher](./launcher/README.md) | Not published | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=go-launcher)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components) | The launcher's libraries: its engine, the reader of a knowledge base's documents (`stack`), what an image declares (`images`) and whether a release built it (`provenance`), the verbs on the command line and over MCP (`verbs`), and the fake runtime its tests drive (`fakert`). The program, [apps/launcher](../../apps/launcher/README.md), is built on them |

## Where things are

- Each is a Go module of its own, with its own `go.mod`; the launcher's libraries name the SDK by a `replace` on its path.
- CI measures each module's coverage with `go test -coverprofile`, and uploads it under the flag `go-<name>`. The launcher's libraries are measured twice, and Codecov joins the two:
  - by their tests, with `-coverpkg=./...`, so a package is credited with what any of their tests reach of it;
  - by the scenario suite of [apps/launcher](../../apps/launcher/README.md), whose launcher writes what of them it runs.

  Their test tooling, `fakert` and `harness`, is left out of the count.

The other languages, and which SDK a program installs, are in [packages/](../README.md).
