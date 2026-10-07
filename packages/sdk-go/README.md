# Semiont Go client

The Go client the [`semiont` launcher](../../apps/launcher/README.md) is built
on: the gateway's HTTP operations as generated Go, and the event bus's
vocabulary with a client that speaks it. Module
`github.com/The-AI-Alliance/semiont/packages/sdk-go`, package `semiont`.

```go
import semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
```

A program that builds on a knowledge base uses the
[TypeScript](../sdk/README.md), [Rust](../sdk-rust/README.md) or
[Python](../sdk-python/README.md) SDK: a client of the eight verbs, with
sessions and live queries, held to a
[conformance suite](../../tests/conformance/sdk/README.md). This module sits
below those. It has no verb namespaces, no sessions and no cache, and that
suite does not run it. The launcher's commands are written directly on what
it does have.

## What is in it

| Package | Holds | Generated from |
|---|---|---|
| `semiont` | `client_gen.go`: a Go type for every schema of the spec, and a typed HTTP call for every operation. `health.go`: the `Health` interface and `HealthClient`, which asks the gateway whether it is serving | [`specs/src/openapi.json`](../../specs/src/openapi.json), bundled |
| [`bus`](#the-bus-package) | The bus's channels, the schema each emittable channel carries, and its request and reply operations. `Transport`, and `Client`, its implementation over HTTP | [`specs/src/bus/registry.json`](../../specs/src/bus/registry.json), and two hand-written files |
| `bustest` | `Fake`, a `bus.Transport` with no server, for tests | hand-written |
| [`mediatypes`](#the-mediatypes-package) | The media types a knowledge base admits, and `ForExtension` | [`specs/src/media-types/registry.json`](../../specs/src/media-types/registry.json) |

Everything generated is committed, as the monorepo's other generated
artifacts are. A consumer never needs a generator, and a change to the
spec shows up as a diff someone reviews.

## How the launcher uses it

- **The eight verbs** (`semiont yield`, `semiont browse` and the rest) are
  requests and emits over `bus.Transport`. What a verb means is in the spec
  and the services behind the gateway, not in Go.
- **`semiont yield --upload`** sends a file's bytes with the generated
  `PostResourcesWithBodyWithResponse`, and `mediatypes.ForExtension` names the
  media type its extension stands for.
- **`semiont login`** is an OAuth device grant at the knowledge base's issuer,
  which no generated operation covers. The client's part is to ask the
  knowledge base which issuer that is
  (`GetWellKnownOauthProtectedResourceWithResponse`), and to check that the
  gateway accepts the token it was issued (`GetApiUsersMeWithResponse`).
- **Its tests** run the verbs against `bustest.Fake`, with no server.

The launcher depends on this module through a `replace` directive on its
relative path (see its `go.mod`). The module is published nowhere: the import
path is its identity, and the launcher is its consumer.

## Regenerating the client

Nothing regenerates by itself. When the spec changes:

```sh
cd packages/sdk-go && go generate ./...
```

That runs the pinned generator (`oapi-codegen@v2.6.0`) in a `golang`
container at the toolchain `go.mod` names, so no Go is needed on the host. It
reads the bundle `npm run openapi:bundle` writes and rewrites `client_gen.go`.
Commit the result. CI runs the same generator and fails while the committed
client differs from what the spec generates.

Generation covers the whole spec on purpose: a Go type for every schema and a
complete typed call for every operation. It runs with `skip-prune`, because
oapi-codegen otherwise drops every schema no HTTP path reaches, which is the
whole of the bus's payload vocabulary. The drift check compares the generator
with itself and cannot see that kind of gap, so a second check in CI
(`scripts/ci/check-go-schema-coverage.mjs`) holds the count of generated types
to the count of schemas in the spec.

## The `bus` package

`bus/` holds the event bus's vocabulary: channel constants, the map from each
emittable channel to its schema, the request and reply operations, and the
broadcasts a client subscribes to. It is generated from
[`specs/src/bus/registry.json`](../../specs/src/bus/registry.json), the
registry every SDK's channel tables come from, which is what keeps the
languages from drifting apart.

```sh
npm run generate:bus          # regenerate the TypeScript and Go sides
```

```sh
npm run generate:bus:check    # verify without writing, as CI does
```

A channel whose payload exists only in TypeScript (DOM geometry, callbacks) is
left out: it never crosses the wire. Payload structs are not generated here.
The schema a channel carries has its Go type in `client_gen.go`. See
[the event bus](../../docs/protocol/EVENT-BUS.md).

Two files are hand-written. `transport.go` states what a consumer needs of the
bus as the `Transport` interface: `BaseURL`, `Emit`, `Subscribe` and
`Request`. `client.go` is `Client`, its implementation over HTTP:
`POST /bus/emit`, the event stream of `POST /bus/subscribe`, and the
correlated request and reply.

`bustest.Fake` implements `bus.Transport` in process. It records every `Emit`
and `Request` with its payload, and answers each request with the reply the
test scripted. It does not model `Subscribe`, which returns an error.

## The `mediatypes` package

`mediatypes/` holds the media types a knowledge base admits, generated from
[`specs/src/media-types/registry.json`](../../specs/src/media-types/registry.json),
the registry every SDK generates from. `mediatypes.ForExtension` names the
media type a file's extension stands for: the first row that states the
extension, after the registry's aliases.

```sh
npm run generate:media-types-go          # regenerate
```

```sh
npm run generate:media-types-go:check    # verify without writing, as CI does
```

## License

Apache-2.0. See [LICENSE](../../LICENSE).
