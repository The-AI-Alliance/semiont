# stack — the documents that describe a knowledge base's stack, and the Browser

A knowledge base's repository commits its stack as documents in Kubernetes'
resource format (`apiVersion`, `kind`, `metadata`, `spec`), one file for each
document in `.semiont/stack/`. Each kind is a group of services that lives
and dies together, and each document names every container it runs with its
image and its memory. A document never states where anything listens: the
documents refer to one another by `metadata.name`, and whoever runs the
stack places what they describe. The launcher places it on one machine; a
deployment elsewhere edits its own copy.

| Kind | Schema | Holds |
|---|---|---|
| `KnowledgeBase` | [`KnowledgeBase.json`](KnowledgeBase.json) | the Gateway, the Dispatcher, the Archivist, the broker between them, and the issuer the knowledge base trusts |
| `KnowledgeIndex` | [`KnowledgeIndex.json`](KnowledgeIndex.json) | the graph store, the vector store, the embedding model, and the Librarian, the Smelter and the Weaver |
| `Issuer` | [`Issuer.json`](Issuer.json) | an issuer the launcher runs, and the database it keeps its realm in |
| `WorkerPool` | [`WorkerPool.json`](WorkerPool.json) | the Worker |
| `Inference` | [`Inference.json`](Inference.json) | the providers a machine reaches, and which provider and model serve each role ([`ArchivistRoster`](../components/schemas/ArchivistRoster.json)) |

Every kind's `apiVersion` is [`ApiVersion.json`](ApiVersion.json)'s:
`semiont.the-ai-alliance.github.io/v1alpha1`. The objects the kinds share are
[`Metadata.json`](Metadata.json), [`Image.json`](Image.json),
[`Resources.json`](Resources.json), [`SecretRef.json`](SecretRef.json),
[`HostPort.json`](HostPort.json) and [`Provider.json`](Provider.json).
[`Runner.json`](Runner.json) is the one rule every daemon follows: the
launcher runs it, from `image` with `resources`, or somebody else does, at
`external`, never both.

## Documents outside any knowledge base

What serves every knowledge base on a machine belongs to none of them, so its
document is kept in the launcher's state home, in `stack/`, and in no
knowledge base's repository. The first command that needs one and
finds none writes it from the launcher's catalog and says where; from then on
the file is what runs.

| Kind | Schema | File | Holds |
|---|---|---|---|
| `Browser` | [`Browser.json`](Browser.json) | `stack/browser.yaml` | the Browser: its image, its memory, and the port it is published on, on the machine's loopback |

## The project file

A knowledge base's project file, `.semiont/config.yaml`, is held to
[`../kb-identity/ProjectConfig.json`](../kb-identity/ProjectConfig.json): its
name, whether its changes are staged in git, and its identity. No stack
document restates any of it.

## A secret

A document never holds a secret. It names one with a
[`SecretRef`](SecretRef.json): `apiKey: { fromEnv: ANTHROPIC_API_KEY }`. The
passwords of the daemons the launcher runs are the launcher's to generate and
keep, and no document names them.

## What holds a document to its schema

- **The cases.** [`cases.json`](cases.json) states, for a document, whether it
  is accepted, or refused where and why. `scripts/spec/check-stack.mjs`
  (`lint:spec-stack`) runs every case with Ajv, and so does the launcher
  (`packages/go/launcher/stack/read_test.go`), with the schemas it carries.
  The lint also validates every document of the launcher's fixture knowledge
  base, and fails on a schema no case is refused against.
- **The launcher's reader.** `packages/go/launcher/stack` validates a
  document against its schema, naming the line of each refusal, and only then
  decodes it into its type. The types and the schema text are generated:
  `node scripts/spec/generate-stack-go.mjs`, checked for drift in CI, and
  `lint:spec-stack` holds every property of a schema to a field of the types.
