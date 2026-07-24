# @semiont — Go client (`packages/sdk-go`)

The Go client for the Semiont API, **generated** from the OpenAPI authority
at [`specs/openapi.json`](../../specs/openapi.json) — the same single
source of truth the TypeScript SDK's types derive from. Package name:
`semiont`; import path (permanent, chosen for eventual publication):

```go
import semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
```

## What's in here, and what's committed

| File | Origin | Committed? |
|---|---|---|
| `generate.go` | hand-written — package doc + the `go:generate` directive | yes |
| `client_gen.go` | **generated** by oapi-codegen | **yes, deliberately** |
| `go.mod` / `go.sum` | module boundary + dependency locks | yes |

The generated client is versioned (same policy as the monorepo's other
generated artifacts, e.g. `packages/core/src/types.ts` and the launcher's
discovery types): consumers and CI never need the generator toolchain, and
spec-driven changes show up as reviewable diffs.

## Regenerating

**Nothing regenerates automatically.** When the spec changes and the Go
client should pick it up:

```sh
cd packages/sdk-go && go generate ./...
```

That runs the pinned generator (`oapi-codegen@v2.6.0`) inside a
`golang:1.25` container — no host Go needed — against `specs/openapi.json`,
rewriting `client_gen.go`. Commit the result. Until someone regenerates,
the committed client lags the spec safely: it can't drift into wrongness,
it just doesn't know about new endpoints yet.

Generation is **full-surface** by measured choice (2026-07-24: 37
operations, ~7.7k lines, compiles clean): every operation is a complete
typed HTTP call, and filtering machinery would solve a scale problem this
spec does not have.

## Consuming

The launcher (`apps/launcher`) is the first consumer, via a `replace`
directive on this module's relative path — see its `go.mod`. Its `login`
and `yield` commands are thin glue over `PostApiTokensPasswordWithResponse`
and `PostResourcesWithBodyWithResponse`; that's the intended pattern —
knowledge-verb semantics live in the spec and the backend, not in Go code.

## Publishing (later)

This module is not published yet, but the path already is its identity.
When the time comes: drop the launcher's `replace`, push a tag named
`packages/sdk-go/vX.Y.Z` (Go's subdirectory-module convention), and
`go get github.com/The-AI-Alliance/semiont/packages/sdk-go@vX.Y.Z` works —
there is no registry step beyond the tag. If a shorter import path is ever
wanted, mirroring to a dedicated repo at release time remains open; nothing
here forecloses it.
