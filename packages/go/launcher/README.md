# The launcher's libraries

The Go module `github.com/The-AI-Alliance/semiont/packages/go/launcher`: what
the `semiont` launcher is built from. The program itself, its `main` and the
tests that build it and drive it, is [apps/launcher](../../../apps/launcher/README.md),
which says what the launcher does and how to use it.

| Package | What it is |
|---|---|
| `launcher` (this directory) | The engine: `init`, `start`, `stop`, `status`, codespaces, identity and custody, each command's work planned before it is run |
| `stack` | Reads a knowledge base's documents, `.semiont/stack/` and `.semiont/config.yaml`, each held to its schema in `specs/src/stack` |
| `provenance` | Decides whether an image is one a release built: its digest, an attestation of that digest, and a signature a trusted root vouches for |
| `images` | Reads what a Semiont service image declares about itself |
| `verbs` | The verbs, on the command line and over MCP, on the [Go SDK](../sdk/README.md) |
| `harness`, `fakert` | What the tests are built on: the scaffolding both suites share, and the fake runtime that impersonates `container`, Docker, Podman, git and the process tools on a private `PATH` |

It is published nowhere. The program depends on it through a `replace` on its
relative path, as it does on the Go SDK:

```text
replace github.com/The-AI-Alliance/semiont/packages/go/launcher => ../../packages/go/launcher
```

`testdata/` holds the fixture knowledge base and the golden argv files; this
module's tests and the program's both read them.
