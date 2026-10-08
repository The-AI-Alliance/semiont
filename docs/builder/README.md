# Building with the Semiont SDK

> ⚠️ **Alpha.** API and package surface are not yet stable; breaking changes between 0.x releases are expected.

For people, and AI agents, writing software that works with a Semiont knowledge base: a web, desktop or mobile application, an ingestion or enrichment pipeline, a service, an agent.

The SDK is one typed client in three languages. Install the one you write in.

TypeScript:

```bash
npm install @semiont/sdk
```

Rust:

```bash
cargo add semiont
cargo add semiont-http-transport --features sign-in    # the transport over a gateway
```

Python:

```bash
pip install semiont
```

**Then go to the [Developer Guide](./DEVELOPER-GUIDE.md).** It is the way in: short recipes in the order you will need them. You connect, read, ingest a document, enrich it, gather context around it, generate from it, react to what other participants do, and test what you built.

The client needs a knowledge base to talk to. The [Quick Start](./QUICK-START.md) gets one running on your machine.

## What you are building on

- **One wire, eight verbs.** Everything a participant does travels over one event bus, as one of eight verbs: four that write (**yield · mark · bind · frame**), three that read (**browse · match · gather**), and one that directs attention (**beckon**). They are the client's namespaces in every SDK. [The protocol](../protocol/README.md) specifies them independently of any language.
- **The SDK is the boundary.** Your code never calls the gateway's HTTP API directly. Something the SDK lacks is a gap to raise, not a reason to reach around it.
- **Three SDKs, one contract.** TypeScript, Rust and Python have the same namespaces and methods, and are held to one [conformance suite](../../tests/conformance/sdk/README.md) against a real gateway. What you learn in one carries to the others.
- **People and AI agents are the same kind of participant.** They use the same client and the same verbs, and every annotation records who made it.
- **Data is live.** A read is a query that stays current as others write. Work a model does is a job you start and watch.

The [Introduction](./INTRODUCTION.md) explains these ideas. [Architecture](../architecture/README.md) is how Semiont works behind the gateway.

## Where the SDK goes

The SDK is a library, not a service. It runs no process of its own: you give a client a transport and somewhere to keep its session, and it lives inside whatever you are building.

- **A web app.** The TypeScript SDK in the page, with the session in the browser's storage. [`@semiont/react-ui`](../../packages/react-ui/README.md) adds the resource viewer and the annotation components. The Semiont Browser is built this way.
- **A desktop app.** The TypeScript SDK in a webview, as Semiont's own desktop app has it, or the Rust SDK in a native one. A person signs in in their own browser and is sent back to the app.
- **A mobile app.** The same shape as a desktop app. Nothing in the SDK assumes a browser or a server around it, and where a session is kept is an interface, so the app keeps it in the platform's own secure store.
- **An ingestion or enrichment pipeline.** A script or a scheduled job, in any of the three languages. It signs in once, yields documents, and annotates them itself or has a model do it with `mark.delegate` and follows the job.
- **A service.** A long-running process that hears what happens in the knowledge base as it happens, and acts on it. It signs in with an account of its own.
- **An agent.** The same client a person's application uses. The [agent skills](./skills/README.md) are ready-made definitions for AI coding assistants, one per task.

How a program signs in follows from which of these it is, and no password passes through your code in any of them. Each SDK's README shows the forms it has.

From a shell, the [`semiont` launcher](../../apps/launcher/README.md#login-and-upload) speaks the same eight verbs: `semiont yield`, `semiont browse` and the rest, each with `--help`.

## The docs

Read in this order. Most people need only the first three.

| Doc | What it is for |
|---|---|
| [Quick Start](./QUICK-START.md) | A knowledge base running on your machine, to build against |
| [Introduction](./INTRODUCTION.md) | The ideas, once: one wire, annotations as data, AI work as jobs, live data, and where your code sits |
| **[Developer Guide](./DEVELOPER-GUIDE.md)** | **How to build: the recipes, with the exact lines** |
| [Usage](./Usage.md) | The reference: every method of every namespace, its options, what it returns, and the errors |
| [Reactive model](./REACTIVE-MODEL.md) | Why a method returns what it does: the nine shapes every SDK shares, in TypeScript, Rust and Python |
| [State units](./STATE-UNITS.md) | The pattern for coordinated page and flow state in an application, in TypeScript and Rust |
| [Cache semantics](../protocol/CACHE-SEMANTICS.md) | The numbered contract every SDK's live queries are held to |

The guides' examples are TypeScript. The namespaces, methods and behaviour are the same in Rust and Python, and each SDK's README shows them in its own language:

- **[TypeScript](../../packages/sdk/README.md)**, `@semiont/sdk`: what the guides are written in.
- **[Rust](../../packages/sdk-rust/README.md)**, the `semiont` crate: maps each TypeScript shape in these docs to its Rust form. [`semiont-http-transport`](../../packages/http-transport-rust/README.md) has the sessions and signing in.
- **[Python](../../packages/sdk-python/README.md)**, the `semiont` package: runs on asyncio, and is checked by `mypy` and `pyright`, both strict. It has the client, live queries and sessions, and no state units and no registry of several knowledge bases.

## Agent skills

[`skills/`](./skills/README.md) holds one ready-made definition per task for an AI coding assistant: ingesting, annotating, linking, and the layers a knowledge base is built in. A person and an agent use the same client and the same verbs, so nothing in these docs is for one and not the other. The Introduction's [Could your coding agent just build this?](./INTRODUCTION.md#could-your-coding-agent-just-build-this) is addressed to agents and the people directing them.

## Other readers

Running a knowledge base is [docs/operator](../operator/README.md). Changing Semiont itself, these docs and the SDK included, is [docs/contributor](../contributor/README.md).
