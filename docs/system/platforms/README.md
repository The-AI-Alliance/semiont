# Platforms

> **The platform abstraction is gone.** A retired CLI once carried a
> `(platform × serviceType × command)` handler matrix — `posix`, `container`, `aws`, `external`,
> `mock` — that provisioned and started services. Both the matrix and the CLI have been deleted.
> There is no per-platform configuration to write.

## How Semiont runs now

Semiont ships eight container images (`semiont-gateway`, `semiont-browser`, `semiont-archivist`,
`semiont-librarian`, `semiont-worker`, `semiont-smelter`, `semiont-weaver`, `semiont-dispatcher`) plus the
infrastructure containers a stack needs
(`postgres`, `neo4j`, `qdrant`, and `ollama` for local inference).

A knowledge-base stack is brought up by **the `semiont` launcher** —
`brew install the-ai-alliance/semiont/semiont`, then `semiont start` from a KB directory. It works
locally against Docker / Podman / Apple Container, and in GitHub Codespaces, where the codespace's
own launcher runs the stack. See [apps/launcher](../../../apps/launcher/README.md).

## Where to read next

- [CONTAINER-TOPOLOGY.md](../CONTAINER-TOPOLOGY.md) — what runs where, and which layer runs it
- [administration/DEPLOYMENT.md](../administration/DEPLOYMENT.md) — how stacks are deployed
- [Running Semiont on AWS](./AWS.md) — scheduling the images on ECS Fargate or similar; unsupported,
  and entirely your own integration
- [administration/IMAGES.md](../administration/IMAGES.md) — how the images are built and published
