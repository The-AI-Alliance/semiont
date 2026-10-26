# Semiont Go client

The Go client the [`semiont` launcher](../../apps/launcher/README.md) is built
on: the gateway's HTTP operations as generated Go, the event bus's vocabulary,
and a transport that speaks it. Module
`github.com/The-AI-Alliance/semiont/packages/sdk-go`, package `semiont`.

```go
import semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
```

A program that builds on a knowledge base uses the
[TypeScript](../sdk/README.md), [Rust](../sdk-rust/README.md) or
[Python](../sdk-python/README.md) SDK: a client of the eight verbs, with
sessions and live queries, held to a
[conformance suite](../../tests/conformance/sdk/README.md). This module's
transport is held to that suite's wire cases, as theirs are, and its session
to the session table every SDK runs. It has no verb namespaces and no cache:
the launcher's commands are written directly on the transport.

## What is in it

| Package | Holds | Generated from |
|---|---|---|
| `api` | `client_gen.go`: a Go type for every schema of the spec, and a typed HTTP call for every operation. `ids_gen.go`: the kinds of id, each a type made only through its kind's rule (`ParseResourceId` and the others), which the wire types carry | [`specs/src/openapi.json`](../../specs/src/openapi.json), bundled; [`specs/src/identifiers/kinds.json`](../../specs/src/identifiers/kinds.json) |
| `semiont` | `httptransport.go` and `stream.go`: `HTTPTransport`, a `Transport` holding one stream to the gateway, its emits, and the gateway's own operations. `wire.go`: `Wire`, its emits, frames and requests by channel. `content.go`: `HTTPContentTransport`, uploads and reads of a resource. `errors.go`: `Error`, `TransportError` and `BusRequestError`. `telemetry.go`: the spans and the count a transport reports, and `Frame.Trace`. `session.go`: `Session`, a knowledge base's token renewed by the session table, and `SignInKept`. `signin.go` and `oauth.go`: `ResumeSession`, `SignInWithDevice` and `SignOut` over `Issuer` (discovery, the device and refresh grants, revocation). `signinstore.go`: `SignInStore`, the sign-ins `semiont login` keeps, under their lock; `statedir.go`: `StateDir`, where they are kept. `agent.go`: `ServiceToken` and `AgentToken`, a software agent's token at the gateway. `endpoint.go`: `GatewayURL`. `token.go`: a token's expiry and when it is renewed. `health.go`: the `Health` interface and `HealthClient`, which asks the gateway whether it is serving. `retry.go`: the retry rules (`RetryRuleBoot`, `RetryRuleTransport`, `RetryRuleRefresh`), `RetryPolicy`, `RetryAfter` and `EqualJitter`. `errorcodes_gen.go`: the failure vocabularies, a type each with a constant per code, `BusRequestErrorCodeOfWire` and `TransportErrorCodeOfStatus`. `timing_gen.go`: `Timing`, a field per entry, and `DefaultTiming`. `telemetry_gen.go`: the SDK telemetry table's names, kinds and attribute keys. `signin_gen.go`: `SignIn`, the store's entry. `oauthclients_gen.go`: the OAuth client ids and the sign-in scope | hand-written; [`specs/src/errors/codes.json`](../../specs/src/errors/codes.json); [`specs/src/client/timing.json`](../../specs/src/client/timing.json); [`specs/src/sdk-telemetry/telemetry.json`](../../specs/src/sdk-telemetry/telemetry.json); [`specs/src/sign-in-store/SignIn.json`](../../specs/src/sign-in-store/SignIn.json); [`specs/src/session/oauth.json`](../../specs/src/session/oauth.json) |
| [`bus`](#the-bus-package) | The bus's channels, the schema each emittable channel carries, and its request and reply operations | [`specs/src/bus/registry.json`](../../specs/src/bus/registry.json) |
| [`semionttest`](#the-semionttest-package) | What a consumer's tests are built on: `NewTestClient`, a real client over `FaultyTransport`, `InMemoryContent` and `StubGateway`; and `AssertStateUnitAxioms` | hand-written |
| [`mediatypes`](#the-mediatypes-package) | The media types a knowledge base admits, and `ForExtension` | [`specs/src/media-types/registry.json`](../../specs/src/media-types/registry.json) |

Everything generated is committed, as the monorepo's other generated
artifacts are. A consumer never needs a generator, and a change to the
spec shows up as a diff someone reviews.

## How the launcher uses it

- **The eight verbs** (`semiont yield`, `semiont browse` and the rest) are
  requests, emits and frames over a `semiont.Transport`, one per command,
  whose token the launcher's session renews. What a verb means is in the spec
  and the services behind the gateway, not in Go.
- **`semiont yield --upload`** sends a file's bytes with the generated
  `UploadResourceWithBodyWithResponse`, and `mediatypes.ForExtension` names the
  media type its extension stands for.
- **`semiont login`** is an OAuth device grant at the knowledge base's issuer,
  which no generated operation covers. The client's part is to ask the
  knowledge base which issuer that is
  (`GetProtectedResourceMetadataWithResponse`), and to check that the
  gateway accepts the token it was issued (`GetCurrentUserWithResponse`).
- **Its tests** run the verbs against `semionttest.FaultyTransport`, with no server.

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
reads the bundle `npm run openapi:bundle` writes and rewrites `api/client_gen.go`.
Commit the result. CI runs the same generator and fails while the committed
client differs from what the spec generates.

What the generator is told is in [`oapi-codegen.yaml`](oapi-codegen.yaml), the
one file `go generate`, CI and `scripts/ci/local-build.sh` all give it. Each
of the three adds only the spec's path and the path it writes to.

Generation covers the whole spec on purpose: a Go type for every schema and a
complete typed call for every operation. The file sets `skip-prune`, because
oapi-codegen otherwise drops every schema no HTTP path reaches, which is the
whole of the bus's payload vocabulary. The drift check compares the generator
with itself and cannot see that kind of gap, so a second check in CI
(`scripts/ci/check-go-schema-coverage.mjs`) holds the count of generated types
to the count of schemas in the spec.

The file also sets `always-prefix-enum-values`: every enum constant is named
by its type and then its value, as `LogFormatJson` is the `json` of
`LogFormat`. A schema that reuses a value another schema has renames no
constant.

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
The schema a channel carries has its Go type in `api/client_gen.go`. See
[the event bus](../../docs/protocol/EVENT-BUS.md).

Nothing in it is hand-written. What carries the bus is package `semiont`'s
`Transport`, held to the SDK conformance suite.

## The `semionttest` package

`semionttest/` is what a consumer's tests are built on, at parity with the
other SDKs' test doubles (Python's `semiont.testing`). `NewTestClient` gives a
real `semiont.Client` over three doubles:

- `FaultyTransport`, a `semiont.Transport` with no wire. A test scripts what
  the gateway answers (`QueueReply`, a `MakeResponse`, `RefuseWhen`) and what
  the wire does to each request (`Deliver`, `DropReply`, `Delay`,
  `DuplicateReply`, `RejectEmit`), and reads what was sent (`RequestLog`,
  `Emitted`) and what is held (`Holds`, `Scopes`, `PendingReplies`). A request
  nobody scripted is refused, naming its operation.
- `InMemoryContent`, a content transport that keeps what it is given, and
  refuses a read of what nobody stored, naming the resource.
- `StubGateway`, which answers only what it was told to.

`AssertStateUnitAxioms` holds a state unit to what every unit promises. Each
double works inside a `testing/synctest` bubble.

## The `mediatypes` package

`mediatypes/` holds the media types a knowledge base admits, generated from
[`specs/src/media-types/registry.json`](../../specs/src/media-types/registry.json),
the registry every SDK generates from. `mediatypes.ForExtension` names the
media type a file's extension stands for: the first row that states the
extension, after the registry's aliases.

```sh
npm run generate:go          # regenerate the Go SDK's tables
```

```sh
npm run generate:go:check    # verify without writing, as CI does
```

## License

Apache-2.0. See [LICENSE](../../LICENSE).
