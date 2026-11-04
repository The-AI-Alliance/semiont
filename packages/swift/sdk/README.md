# Semiont Swift SDK

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=swift-sdk)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

The framework-free Swift SDK for Apple apps and Linux services. It is not published; its checked identifiers, wire models and protocol tables are generated from the spec at build time.

From the repository root:

```bash
container run --rm --memory 8g -e HOME=/tmp/swift-home -v "$PWD":/w -w /w/packages/swift/sdk "swift:$(packages/swift/scripts/swift-version.sh)" sh -c 'mkdir -p "$HOME" && Scripts/test.sh && Scripts/coverage.sh && swift format lint --strict --recursive . && Scripts/census.sh && Scripts/refusals.sh'
```

Swift 6 language mode and warnings as errors apply to every target. The canary must fail with the concurrency diagnostic. Each future `Refusals/*.swift` program begins `// refused: <text>` and must fail with that message. The census forbids unchecked concurrency escapes and environment reads beyond `SEMIONT_BUS_LOG`. The formatter forbids force unwraps, force casts, force tries and implicitly unwrapped optionals throughout the package.

The tests round-trip payloads from the three conformance corpora, run every identifier case, and verify nullable members, open objects, table generation and refused schema shapes. `SemiontTesting` arrives with its first implementation. Publishing is a separate plan.

The build-tool plugin runs the native Swift generator over `protocol/specs/src`, including files outside the SwiftPM package. Generated models and test dispatch live only in `.build`. Models keep timestamps and URIs as strings, use checked value types for identifiers, and preserve the three states of an optional nullable member with `Stated`. `JSONValue` carries values in open objects. Required nullable members must be present, even when null.

`Scripts/test.sh` builds instrumented tests and collects their LLVM profiles directly. `Scripts/coverage.sh` exports both compiled test libraries, avoiding SwiftPM's automatic JSON export of dependency coverage. Coverage includes the generator, which is also run over the complete spec by its tests. The testing product remains a later phase.

The HTTP transport uses the caller's AsyncHTTPClient `HTTPClient` for every request. Its default proxy setting is `nil`; it does not read proxy environment variables. Callers configure trust and proxies on that client and shut it down after disposing the transport. The SDK reads only `SEMIONT_BUS_LOG`.

`HttpTransport` exposes connection state, independent lossless `frames` sequences (several channels can share one ordered sequence), scoped holds, correlated requests, uploads and content reads. `dispose()` synchronously cancels owned work and finishes sequences. A second iterator on an events, upload or content stream throws `MultipleConsumers`. Incoming trace carriers are lifted out of payloads into `ReceivedFrame.trace`. OpenTelemetry's API is the library's only telemetry dependency; the application selects its provider and exporters.

The concurrency primitives require macOS 15 or iOS 18; Linux is tested in the Swift container. `Scripts/install-driver.sh` builds the instrumented Linux wire driver and bundles its Swift runtime. The conformance application chooses OTLP/HTTP exporters when the harness supplies `OTEL_EXPORTER_OTLP_ENDPOINT`. Its runtime matches Ubuntu 26.04. `Scripts/conformance-coverage.sh` reports the library code the driver exercised, separately from Rust's LLVM profiles.

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
user state are read-only, and their sequences finish on disposal. The remaining live queries and registry surfaces arrive in later phases.

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

`SemiontClient.fromHttp(baseUrl:httpClient:token:)` constructs the HTTP client
surface. `SemiontClient(transport:gateway:content:)` takes another `Transport`, with
`auth` and `system` present only when a `GatewayOperations` is supplied. Browse
content reads and Yield uploads use the supplied `ContentTransport` or the
client transport itself when it conforms. The client implements 54 of the 66
namespace methods: vocabulary writes, binding,
attention, authentication/status, annotation writes, job events/status/cancellation,
gather/search operations, delegation, uploads and cloning, and Browse history,
directory, knowledge-base, navigation, graph, anchored text and binary reads.
Decoded text, cache-backed queries and worker claims follow later.
Dispose the client before shutting down the caller-owned HTTP client.

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
`sessionFromKept` now exposes this client as `OpenedSession.client`; disposing
the owner closes the session and client together.
