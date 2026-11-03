# The Semiont protocol

What every implementation of Semiont is held to, in three parts:

| Directory | What it is |
|---|---|
| [contract/](contract/README.md) | The rules, in prose: the eight verbs, the bus, the record, jobs, each kind of worker and service, and the transports. Start here. |
| [specs/](specs/README.md) | The shapes, machine-readable: the OpenAPI documents, the bus registry, the SDK surface, the configuration documents, and the case tables. Generate from them rather than retyping them. |
| [conformance/](conformance/README.md) | The suites that start an implementation and hold it, from outside, to the other two. |

Everything else in this repository is an implementation: Semiont's services in
[images/](../images/README.md), its SDKs and the libraries they share in
[packages/](../packages/README.md), and its host tools in [apps/](../apps/README.md).
Each reads the protocol from here, and none is part of it.

## Implementing the protocol

1. **Read the contract.** [contract/README.md](contract/README.md) is the
   spine. Each verb's rules are in [contract/flows/](contract/flows/README.md),
   and each process's (the Archivist, the dispatcher, a worker, the Weaver, the
   Smelter, the Librarian) on a page of its own.
2. **Generate from the specs.** Types, channel tables and validators come from
   [specs/src/](specs/src/); Semiont's generators in [packages/codegen](../packages/codegen/README.md)
   and in each SDK show how. A [case table](specs/README.md#case-tables) states a
   rule case by case: run it in your own unit tests, by calling your own function.
3. **Run the conformance suites against your build.** Write an
   [implementations file](conformance/README.md#the-implementations-file) that
   says how your build is started, and name it after vitest's own arguments:

   ```bash
   cd protocol/conformance
   npm ci
   npx vitest run --project gateway -- --implementations /path/to/mine.implementations.json
   ```

   The suites run from this repository. Every one needs `@semiont/core` built
   and `nats-server` on `PATH`, and some need more
   ([Running them](conformance/README.md#running-them)).
4. **To test an SDK, write a driver**: a small program that turns a suite's
   operations into calls on your SDK's public API and writes back what
   happened. [The driver protocol](conformance/sdk/README.md#the-driver-protocol)
   says what it reads and writes, and [the worker driver](conformance/worker/README.md#the-worker-driver)
   does the same for a worker's surface. Name your drivers in the file's `sdks`.
