# Semiont container images

The eight services that ship as published, attested container images, each built from its
directory here. What runs on a host instead, the `semiont` launcher and Semiont Desktop, is in
[apps/](../apps/README.md). What the images are built on is in [packages/](../packages/README.md).

## The images

| Image | Source | Port | Coverage | What it runs |
| --- | --- | --- | --- | --- |
| `semiont-gateway` | [gateway](./gateway/README.md) | 4000 | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=image-gateway)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components) | **The front door.** It authenticates callers, validates and relays the bus, keeps the reply records, and pipes bytes to and from the Archivist. Rust, built against `specs/` |
| `semiont-archivist` | [archivist](./archivist/README.md) | 24103 | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=image-archivist)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components) | **Keeps the system of record:** the Stower (writes events and projections), the Browser actor (serves `browse:*` reads) and the CloneTokenManager. The only service that mounts the working tree. Rust |
| `semiont-librarian` | [librarian](./librarian/README.md) | 24104 | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=image-librarian)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components) | **Searches the record:** the Gatherer (context assembly) and the Matcher (candidate search and scoring). Python |
| `semiont-smelter` | [smelter](./smelter/README.md) | 24101 | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=image-smelter)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components) | Chunks and embeds content into the vector store, and owns anchored-text extraction. Python, with PDFium and the `tesseract` program |
| `semiont-weaver` | [weaver](./weaver/README.md) | 24102 | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=image-weaver)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components) | Projects the event log into the graph. Python |
| `semiont-worker` | [worker](./worker/README.md) | 24100 | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=image-worker)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components) | Claims queued jobs (detection, generation) and runs inference. Python, with every model provider's library |
| `semiont-dispatcher` | [dispatcher](./dispatcher/README.md) | 24105 | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=image-dispatcher)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components) | **Hands out the work:** it owns the job queue and answers the `job:*` lifecycle commands, a control plane through which no content flows. Rust |
| `semiont-browser` | [browser](./browser/README.md) | 3000 | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=image-browser)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components) | **The Semiont Browser**, the Vite and React app people use. TypeScript |

- **Coverage is each image's own code**, never the packages it is built on: the Rust images'
  crates under their directories, the Python services' own packages, and the Browser's source.
- **Publishing.** The seven services are built by
  [`publish-service-images.yml`](../.github/workflows/publish-service-images.yml), and the
  Browser's image by [`publish-browser.yml`](../.github/workflows/publish-browser.yml). See
  [Container Images](../docs/operator/administration/IMAGES.md).
- **The Browser is an npm package too,**
  [@semiont/browser](https://www.npmjs.com/package/@semiont/browser)
  [![npm](https://img.shields.io/npm/v/@semiont/browser)](https://www.npmjs.com/package/@semiont/browser),
  which its image bundles. The other images are not published to npm.
- What each service reads, mounts and reaches is stated once, in the operator's
  [service catalog](../docs/operator/services/OVERVIEW.md). What the actors inside them do is
  [Knowledge System](../docs/architecture/KNOWLEDGE-SYSTEM.md).

**The Archivist and the Librarian are a deliberate pair.** The Archivist holds the record and
answers *"what is there?"*; the Librarian searches it and answers *"what is relevant to my
question?"*, the distinction the professions themselves draw.

## This directory is the set of images

Every directory here with a `Dockerfile` is an image, and the tooling takes the set from this
directory, not from a list: `scripts/ci/local-build.sh` builds what is here, and the supervision
gate, the NOTICE and Rust-builder lints, the Python licence check and `lint:coverage-roster` all
read it. Two lists are still written by hand, and each is held to this directory: the matrix in
[`publish-service-images.yml`](../.github/workflows/publish-service-images.yml), by
`scripts/release/verify-release.sh`, and the path filters in
[`ci.yml`](../.github/workflows/ci.yml), by `lint:workflows`.

So an image added here needs:

1. its directory: its source, a `Dockerfile` that passes the supervision gate, and a `NOTICE`
   that credits exactly what the image ships;
2. its row in that matrix (the Browser has its own workflow) and a CI path filter;
3. its coverage: a flag and a component `image-<name>` in
   [`codecov.yml`](../.github/codecov.yml), an upload under that flag in `ci.yml`, a badge in its
   README and its row here, which `lint:coverage-roster` names when one is missing;
4. a role in the launcher's [`descriptors.go`](../packages/go/launcher/descriptors.go), which
   is what starts it.
