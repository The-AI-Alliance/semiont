# Semiont Swift SDK

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=swift-sdk)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

The Swift SDK for Apple apps and Linux services. Use it to read and write a
Semiont knowledge base, observe changes as they happen, and delegate jobs to
workers. The SDK shares the other languages' [protocol][protocol] and
[conformance suite][conformance]. The [Developer Guide][guide] shows how
those capabilities fit together.

## Install

The SDK is available as a local Swift package in a Semiont checkout. In Xcode,
add `packages/swift/sdk` from that checkout as a local package and link the
`Semiont` product to your target. With SwiftPM, add a
`.package(path: "../semiont/packages/swift/sdk")` dependency, adjusting the path
for your project, and add `.product(name: "Semiont", package: "sdk")` to the
target's dependencies. Add the `AsyncHTTPClient` product from
[AsyncHTTPClient][http-client] to targets that create the HTTP client.

Keep the full checkout. The SwiftPM build plugin generates wire models and
tables from `protocol/specs/src`. See [the pinned Swift toolchain][toolchain]
for the version used in CI. The SDK supports macOS 15 and iOS 18 or later,
and CI also runs on Linux.

You need a running knowledge base to connect to. The [Quick Start][quick-start]
sets one up locally.

## Connect

A script can sign a person in using the device grant. The issuer provides a
URL and code to show to the person. After they approve in a browser, the
session renews their tokens as needed. Pass a `KbTarget` for the gateway and
a `ResourceId` from that knowledge base to read a resource's metadata.
For a gateway at `http://localhost:4000`, build the target with
`.httpEndpoint(HttpEndpoint(host: "localhost", port: 4000, protocol: .http))`
and give it an ID and label. Your `showCode` callback can print the code's
`verificationUri` and `userCode`.

```swift
import AsyncHTTPClient
import Semiont

func readFirstResource(
  _ resource: ResourceId, in kb: KbTarget,
  showCode: @Sendable (DeviceCode) -> Void
) async throws -> ResourceDescriptor {
  let http = HTTPClient(eventLoopGroupProvider: .singleton)
  let kept = MemorySignIn()
  let descriptor: ResourceDescriptor
  do {
    try await signInDevice(kb: kb, kept: kept, httpClient: http, onCode: showCode)
    let opened = try await sessionFromKept(kb: kb, kept: kept, httpClient: http)
    defer { opened.dispose() }
    try await opened.session.ready()
    descriptor = try await opened.client.browse.resource(resource).fresh()
  } catch {
    try? await http.shutdown()
    throw error
  }
  try await http.shutdown()
  return descriptor
}
```

`MemorySignIn` holds the sign-in for the life of the program. To use an
existing launcher sign-in, open a `SignInStore(path:)` and pass its entry for
the knowledge base to `sessionFromKept`. A desktop or mobile app can sign in
with a browser redirect. See [Registry and state units](#registry-and-state-units).

## Eight verbs

The client's namespaces follow the [eight protocol verbs][flows].

| Verb | What it does | Example methods |
| --- | --- | --- |
| Browse | Navigate, read, and observe the knowledge base | `browse.resource`, `browse.annotations` |
| Frame | Define and extend the vocabulary | `frame.addEntityTypes`, `frame.addTagSchema` |
| Mark | Annotate a resource | `mark.annotation`, `mark.delegate` |
| Bind | Resolve a reference | `bind.body`, `bind.initiate` |
| Gather | Assemble grounding context | `gather.resource`, `gather.annotation` |
| Match | Search for resources and reference candidates | `match.resources`, `match.search` |
| Yield | Upload or generate a resource | `yield.resource`, `yield.delegate` |
| Beckon | Direct attention across participants | `beckon.hover`, `beckon.sparkle` |

The client also exposes `job`, plus `auth` and `system` when it has gateway
operations.

## A first program

With an open session, pass `opened.client` and the ID of a source resource
to this function. It gathers context around the resource, delegates a job
to generate a summary, and waits for the job's result. The knowledge base
needs a worker that handles generation jobs.

```swift
func generate(
  from resource: ResourceId, using client: SemiontClient
) async throws -> YieldJobCompleteCommand {
  let context = try await client.gather.resource(resource)
  let run = try client.yield.delegate(
    params: GenerationJobParams(
      context: context, storageUri: "file://summary.md", title: "Summary"))
  return try await run.completed()
}
```

## Live queries

Use a live query to keep a view up to date while other participants write.
This example receives each state until the caller cancels or disposes the
client.

```swift
func watchResource(
  _ resource: ResourceId, using client: SemiontClient,
  show: (CacheState<ResourceDescriptor>) -> Void
) async {
  for await state in client.browse.resource(resource) {
    switch state {
    case .pending: show(.pending)
    case .ready(let resource): show(.ready(resource))
    case .failed(let error): show(.failed(error))
    }
  }
}
```

Iterate a live query's `Cached` sequence for `CacheState.pending`,
`.ready(value)`, and `.failed(error)`. Iterating a resource-scoped query holds
the resource's event subscription until iteration ends. Call `fresh()` to ask
the service directly and share its answer with observers. Disposing the client
ends the sequences.

Pass `CachePersistence(storage:keyPrefix:)` as the client's `persistence` option
to keep resource details, annotations, and vocabulary in application-provided
`SessionStorage`. Use a distinct prefix for each knowledge base. The first
observation shows the saved value while asking for a current one. The HTTP
transport resumes saved resource scopes from bookmarks committed with the cache.
Disposal flushes pending settled values.

## Signing in and managing a session

Sign-in uses the same caller-owned HTTP client. `ServiceToken` supports a client
secret or an RSA key (`CryptoExtras._RSA.Signing.PrivateKey`); `AgentToken` asks
the gateway for its DID once and keeps its last token when a renewal fails.
`signInDevice` shows the issuer’s device code through its callback and keeps the
result in a `SignInKept`. `whoAmI` asks the gateway once without opening a stream.

`SignInStore(path:)` reads the launcher’s `tokens.json`; `entry` selects a stack.
Writes hold `flock` on the sibling `tokens.lock`, use owner-only modes generated
from the contract, and rename a sibling temporary file. Unknown document members
survive. `MemorySignIn` follows the same renewal rules. `stateDir` computes the
launcher’s directory from values the application supplies; it reads no environment.

`sessionFromKept` returns an `OpenedSession`, which owns the session and its HTTP
transport. Dispose that owner before shutting down the HTTP client. The session’s
`ready()` raises startup task failures; `errors()` reports session, transport and
storage failures. Pass `onError` to hear diagnostics from the start of construction,
including before the factory returns. Startup is bounded, overlapping refusals share one renewal, and a failed
network renewal keeps the stored sign-in for another attempt. Session token and
user state are read-only, and their sequences finish on disposal.

Use `SemiontClient.fromHttp(baseUrl:httpClient:token:)` for a short-lived
program that already holds an access token. Use a session when the program
needs renewal. See [Signing in][sign-in] for the available flows.

## Delegated work and workers

`gather.annotation` and `match.search` return a lazy `Running<T>`. Await
`completed()` for its result, or use `for try await` for its reports and final
value. Each operation has one consumer; constructing it or its iterator sends
nothing. Cancellation, leaving a loop, or `dispose()` stops its owned work.
Closing the client ends an unfinished operation with `bus.closed`.

`mark.delegate` and `yield.delegate` return a `Delegation` of that verb's typed
completion. Iteration reports creation first, then progress and retry setbacks,
and finally completion. Awaiting `completed()` returns just the completion.
A quiet job is checked through status polling, one request at a time; retry
setbacks keep the follower alive. A generation's stall deadline grows with its
requested length unless supplied explicitly. Stalling asks for job cancellation;
cancelling the follower itself stops observing and leaves the job running.

`job.queued`, `progress`, `complete` and `fail` are independent typed listeners
that start when asked for. `pollUntilComplete` reports every status through its
optional callback and bounds requests and sleeps by the caller's deadline.

Workers configure their HTTP transport with `jobClaimChannels` and add
`jobCommitChannels` when they write annotations. Iterate `client.job.claim`
to take matching jobs one at a time. A held job exposes cancellation, progress,
checkpoints, and settlement. Cast it to `HeldMarkJob` or `HeldYieldJob` to
complete it with that verb's result. Await `claims.stop()` before disposing
the worker client so it can settle a job it still holds.

## Registry and state units

Use `newSemiontBrowser` with a `SessionStorage` and an `HttpSessionFactory`
to remember knowledge bases, activate a session, and keep open resources
for each knowledge base. `beginSignIn` returns the issuer URL for the
authorization-code flow with PKCE. Pass the redirect callback to
`completeSignIn` to exchange the code, confirm which knowledge base answered,
and activate it. Launcher discovery can read a document supplied by the app
or a document over HTTP. The discovery stream reports absent launchers,
managed knowledge bases, and changes by address.

State units expose read-only `Watched` values for a viewer or application.
Use `MarkStateUnit` to compose annotations and follow delegated work,
`YieldStateUnit` for generation, `GatherStateUnit` for annotation and resource
context, and `MatchStateUnit` for searches requested on the local bus.
`BeckonStateUnit`, `HoverDwell`, and `SearchPipeline` hold attention and
search input. `SessionSignals` carries session notices. `Cache` offers the
same read-through queries for app data, with optional `CachePersistence`.

Call `dispose()` on a state unit to cancel its work and finish its streams.
The app owns the client it handed the unit. Await `SemiontBrowser.close()`
to end the active session and wait for registry work before shutting down
the HTTP client.

## Building annotations

Annotation readers accept every generated body, target and selector variant.
`reconcile(text:quoted:)` finds a model's quote and returns the resource's own
words and context; offsets count Unicode scalars. `annotationOfSpan` takes an
`OfSpan` whose `Spanned` text is either plain text or a PDF's `AnchoredText`.
It checks the span before building position/quote selectors or PDF rectangles.
`annotationOfResource` builds an annotation of the whole resource. Both builders
derive the same deterministic annotation ID as the other SDKs. Refused spans
throw `SpanRefusedError` with a generated error code.

Media-type helpers read generated registry rows, including clone formats,
storage filenames, extension aliases, and whether a format's text is decoded
or derived. Shared annotation, offset and media-type cases run in the unit suite.

## Testing a consumer

Link `SemiontTesting` in a test target. Use `ScriptedTransport` for typed
requests and frames, `createTestSession` for a real session over a scripted
transport, and `ScriptedSessions` with `SharedStorage` for registry tests.
`assertLivenessAxioms` checks outputs, settlements, and retry budgets over
repeatable fault schedules. `assertExactlyOnceDelivery` checks event order
and count across interleaved writes and connection transitions.

## Transports, the bus, and telemetry

`SemiontClient.fromHttp(baseUrl:httpClient:token:)` constructs the HTTP client
surface. `SemiontClient(transport:gateway:content:)` takes another `Transport`, with
`auth` and `system` present only when a `GatewayOperations` is supplied. Browse
content and annotation list reads and Yield uploads use the supplied `ContentTransport` or the
client transport itself when it conforms. Custom content transports supply
`getAnnotations(_:)` for the live annotation list. The client implements all 66
namespace methods: vocabulary writes, binding,
attention, authentication/status, annotation writes, job events/status/cancellation,
gather/search operations, delegation, uploads and cloning, and Browse history,
directory, knowledge-base, navigation, graph, decoded and anchored text, and
binary reads. Browse also offers live resource details, annotations, event
history, resource lists, engines with limits, entity types and tag schemas.
Match offers live resource search results, and Gather offers live incoming
references.

`client.wire` sends typed generated `Channels` and `Operations`. `frames` on a
`ScopedChannel` requires a resource and holds that resource only while the read
is alive. Breaking, cancellation, completion or disposal releases the hold.
A `Typed` sequence gives `Heard.delivered` with its original `ReceivedFrame`,
decoded payload and principal, or `Heard.refused` for a malformed payload. A
refusal names the missing member when known and leaves later frames readable.
A second iterator is refused. Channel construction and payload mismatches are
also checked by the compile-refusal suite.

`client.bus` is the client's own bus: local signals stay local, while received
wire frames are bridged into it. Every listener starts when asked for and keeps
every subsequent event. `dispose()` cancels the bridge, disposes the transport
once and finishes listeners. Custom transports can supply read-only state via
`Watched(initial, updates:)`, events via `Events`, and scoped release via
`ResourceHold` without a concurrency escape.

The HTTP transport uses the caller's AsyncHTTPClient `HTTPClient` for every request. Its default proxy setting is `nil`; it does not read proxy environment variables. Callers configure trust and proxies on that client and shut it down after disposing the transport. The SDK reads only `SEMIONT_BUS_LOG`.

`HttpTransport` exposes connection state, independent lossless `frames` sequences (several channels can share one ordered sequence), scoped holds, correlated requests, uploads and content reads. `dispose()` synchronously cancels owned work and finishes sequences. A second iterator on an events, upload or content stream throws `MultipleConsumers`. Incoming trace carriers are lifted out of payloads into `ReceivedFrame.trace`. OpenTelemetry's API is the library's only telemetry dependency; the application selects its provider and exporters.

## Working on the SDK

CI runs the SDK and generator tests in the pinned Swift container on Linux and
natively on Apple silicon. Both jobs run the formatter, census, and
compile-failure checks. On a provisioned macOS runner, use
`swift test --jobs 4 --force-resolved-versions` from `packages/swift/sdk`.
The dependency lock includes the OpenTelemetry exporter's macOS dependencies.
Both jobs use the same lock.

Run the Linux checks from the repository root.

```bash
container run --rm --memory 8g -e HOME=/tmp/swift-home -v "$PWD":/w -w /w/packages/swift/sdk "swift:$(packages/swift/scripts/swift-version.sh)" sh -c 'mkdir -p "$HOME" && Scripts/test.sh && Scripts/coverage.sh && swift format lint --strict --recursive . && Scripts/census.sh && Scripts/refusals.sh'
```

Swift 6 language mode and warnings as errors apply to every target. The canary must fail with the concurrency diagnostic. Each future `Refusals/*.swift` program begins `// refused: <text>` and must fail with that message. The census forbids unchecked concurrency escapes, environment reads beyond `SEMIONT_BUS_LOG`, and a test wait bounded by anything but `testDeadlineMs`: every test starts at once, and on a small runner a second can pass before a test's tasks are scheduled. The formatter forbids force unwraps, force casts, force tries and implicitly unwrapped optionals throughout the package.

The tests round-trip payloads from the three conformance corpora, run every identifier case, and verify nullable members, open objects, table generation and refused schema shapes.

The build-tool plugin runs the native Swift generator over `protocol/specs/src`, including files outside the SwiftPM package. Generated models and test dispatch live only in `.build`. Models keep timestamps and URIs as strings, use checked value types for identifiers, and preserve the three states of an optional nullable member with `Stated`. `JSONValue` carries values in open objects. Required nullable members must be present, even when null.

`Scripts/test.sh` builds instrumented tests and collects their LLVM profiles directly. `Scripts/coverage.sh` exports both compiled test libraries, avoiding SwiftPM's automatic JSON export of dependency coverage. Coverage includes the generator, which is also run over the complete spec by its tests.

`Scripts/install-driver.sh` builds the instrumented Linux wire driver and bundles its Swift runtime. The conformance application chooses OTLP/HTTP exporters when the harness supplies `OTEL_EXPORTER_OTLP_ENDPOINT`. Its runtime matches Ubuntu 26.04. `Scripts/conformance-coverage.sh` reports the library code the driver exercised, separately from Rust's LLVM profiles.

[protocol]: ../../../protocol/contract/README.md
[conformance]: ../../../protocol/conformance/sdk/README.md
[guide]: ../../../docs/builder/DEVELOPER-GUIDE.md
[http-client]: https://github.com/swift-server/async-http-client
[toolchain]: .swift-version
[quick-start]: ../../../docs/builder/QUICK-START.md
[flows]: ../../../protocol/contract/flows
[sign-in]: ../../../docs/builder/SIGN-IN.md
