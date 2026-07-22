# discovery — the launcher's KB discovery contract

One standalone contract: the schema for `<stateDir>/discovery/kbs.json`,
which the semiont launcher (Go, `apps/launcher`) regenerates on every stack
mutation and consumers read from disk (Node) or fetch same-origin via the
frontend's static server (browsers). Design record:
`.plans/BROWSER-KB-DISCOVERY.md`.

## Why this lives outside `components/schemas/`

Not because it is a "file format" — no such category exists here. The
admission criterion is operational: **a binder outside the TypeScript
pipeline consumes this contract directly** (the launcher's go:generate runs
go-jsonschema against `DiscoveryDocument.json`), so its ref-closure must
stay small and closed. Hence the one hard rule:

- **Schemas in this directory may `$ref` only within this directory.** A ref
  into `components/schemas/` would drag the API surface into every direct
  binder. If a shape is shared with the API, the copy here is the authority
  and the API refs INTO this directory — never the reverse.

TypeScript consumers do not bind these files directly: `openapi.json`
registers them into the bundle by reference, so `@semiont/core` generates
their types alongside the API's.

A future standalone contract (e.g. semiontconfig, whose schema authority
today is `packages/core/src/config/config.schema.json`) gets its OWN sibling
directory and its own deliberate admission — there is deliberately no
generic "formats" area to attract tenants whose closures are not actually
small (the event log, entangled with the domain model and the W3C Web
Annotation vocabulary, is the standing counterexample).

`title` is required in each schema — it names the generated types in every
language.

## Mount point (contract of record)

The frontend container serves this document from the container-internal
directory **`/discovery`** — the launcher mounts `<stateDir>/discovery`
there read-only, and the static server's production default reads from it.
This path is part of the contract: it exists as a literal on both sides of a
language boundary (Go golden-pinned; JS production default), so treat a
change here like a schema change — both sides, deliberately, never a cleanup.
