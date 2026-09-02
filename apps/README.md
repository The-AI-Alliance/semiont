# @semiont Applications

Deployable applications for the Semiont platform.

## Published npm packages

| Package | Version | Source | Description |
| ------- | ------- | ------ | ----------- |
| [@semiont/gateway](https://www.npmjs.com/package/@semiont/gateway) | [![npm](https://img.shields.io/npm/v/@semiont/gateway)](https://www.npmjs.com/package/@semiont/gateway) | [gateway](./gateway/) | Hono API server + event-bus gateway |
| [@semiont/browser](https://www.npmjs.com/package/@semiont/browser) | [![npm](https://img.shields.io/npm/v/@semiont/browser)](https://www.npmjs.com/package/@semiont/browser) | [browser](./browser/) | Vite + React SPA — the Semiont Browser |

The gateway and Browser also ship as published, attested container images
(`ghcr.io/the-ai-alliance/semiont-{gateway,browser}`) that bundle these
packages — see [Container Images](../docs/system/administration/IMAGES.md).

## Container images only

These ship as attested images and are **not** published to npm — their code lives in
`@semiont/make-meaning` (the actors) and `@semiont/jobs` (the processors), and each app
directory is the container entry point plus its Dockerfile.

| Service | Source | Port | What it runs |
| --- | --- | --- | --- |
| `semiont-archivist` | [archivist](./archivist/README.md) | 9093 | **Keeps the system of record** — Stower (writes events + projections), Browser (serves `browse:*` reads), CloneTokenManager. The only service that mounts the working tree |
| `semiont-librarian` | [librarian](./librarian/README.md) | 9094 | **Searches the record** — Gatherer (context assembly) and Matcher (candidate search + scoring) |
| `semiont-smelter` | [smelter](./smelter/README.md) | 9091 | Chunks and embeds content into the vector store; owns anchored-text extraction |
| `semiont-weaver` | [weaver](./weaver/README.md) | 9092 | Projects the event log into the graph |
| `semiont-worker` | [worker](./worker/README.md) | 9090 | Claims queued jobs (detection, generation) and runs inference |

All six service images (the five above plus the gateway) are built by
[`publish-service-images.yml`](../.github/workflows/publish-service-images.yml).

**The Archivist and the Librarian are a deliberate pair.** The Archivist holds the record
and answers *"what is there?"*; the Librarian searches it and answers *"what is relevant to
my question?"* — the distinction the professions themselves draw.

## Host-installed binaries

| App | Source | Distribution | Description |
| --- | ------ | ------------ | ----------- |
| `semiont` launcher | [launcher](./launcher/) | `brew install the-ai-alliance/semiont/semiont` (also [GitHub Releases](https://github.com/The-AI-Alliance/semiont/releases)) | Single static Go binary that runs a local KB stack — pulls the published images and drives Apple `container`, Docker, or Podman directly (`semiont start` / `status` / `logs` / `stop`) |
| Semiont Desktop | [desktop](./desktop/) | [GitHub Releases](https://github.com/The-AI-Alliance/semiont/releases) (macOS, Linux) | Native [Tauri](https://tauri.app/) shell around the Semiont Browser SPA — no container runtime to install and no local-network permission to grant |
