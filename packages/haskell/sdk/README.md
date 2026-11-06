# Semiont Haskell SDK

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=haskell-sdk)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

The Haskell SDK is being built toward the same client and protocol contract
as the other Semiont SDKs. It currently provides protocol types, checked
identifiers, a typed bus and common carrier runtime, read-only state,
scoped operation consumption, retry support, and launcher discovery.
HTTP/SSE and content adapters and the client facade are available, including
the Frame, Auth and System namespaces. Claims, held jobs and durable worker
commits are available. The other namespaces, sign-in, delegation, live queries,
registry and state units are still being implemented.

[Install](#install) · [Signing in](#signing-in) · [Connect](#connect) ·
[Delegation](#delegation) · [Live queries](#live-queries) ·
[Running a worker](#running-a-worker)

## Install

Use the local Cabal package in a Semiont checkout. It is not published on
Hackage. In your application's `cabal.project`, include both packages:

```cabal
packages: ./my-app
          /path/to/semiont/packages/haskell/sdk
```

Add `semiont` to the application's `build-depends`. Use the compiler pinned in
[the development project](../probes/cabal.project). The repository's
[container runner](../run-container.sh) builds and tests the SDK without a host
Haskell installation; see [Building and verifying](#building-and-verifying).

## Signing in

In development. Kept launcher sign-ins, device sign-in, browser redirect,
agent credentials, and session renewal are part of this SDK's implementation
scope. There is no public Haskell sign-in API yet. The shared
[sign-in guide](../../../docs/builder/SIGN-IN.md) describes the supported flows
in the other SDKs.

## Connect

Build a reusable HTTP pool with `Semiont.Http.newHttpClient`, supplying an
explicit proxy policy and your `http-client` `ManagerSettings`. For example,
`newHttpClient noProxy tlsManagerSettings` uses your TLS settings without an
environment-selected proxy; `tlsManagerSettings` is supplied by
`http-client-tls`. The pool disables implicit retries and response timeouts so
Semiont owns its attempt budgets and deadlines. A transport never closes the
caller's pool. Its active requests and response scopes end on disposal.

Supply the pool through `HttpOptions`, together with the base URL, token reader,
refused-token renewal action, fresh UUID action, global channel profile, monotonic
clock/wait/jitter actions, timing settings, and replay-position load/save actions.
`Semiont.Timing.Settings.protocolSettings` supplies the protocol timings;
`withOverrides` validates explicitly supplied timing overrides. Use
`Semiont.Channels.globalChannels` for a full client. All these choices are
explicit. `Client.fromHttp` builds the bus, content and gateway adapters with
the same clock and ID source. Keep the client scoped:

```haskell
module HttpConnection (withConnection) where

import Control.Exception (bracket)
import Semiont.Client (Client, fromHttp, dispose)
import Semiont.Http (HttpOptions)

withConnection :: HttpOptions -> (Client -> IO result) -> IO result
withConnection options = bracket (fromHttp options) dispose
```

`Client.newClient` also accepts independently supplied bus/content adapters and
an optional gateway. Each client constructs and bridges its own local bus.
Disposal closes the transport and content operations before completing that
local bus. `Client.wire` is its typed wire bus; `Client.frame`, `Client.auth` and
`Client.system` expose the currently implemented namespaces.

HTTP content supports scoped binary streams, buffered binary reads, metadata,
annotations and anchored text. Uploads take generated `ResourceUploadMetadata`
and a `ReplayableBody`; `bytesBody` builds a byte source. A source opens again
when a refused credential is renewed. Its idempotency key stays the same and
progress never decreases across replay. A stream retained beyond its callback
refuses further reads.

## Eight verbs

The Haskell client will implement the same namespaces and methods as the
[client surface](../../../protocol/specs/src/client/surface.json). Typed
channel and operation descriptors already exist in `Semiont.Channels`;
Frame, Auth and System namespace methods are available; the remaining namespace
methods are still being implemented. See the
[builder guide](../../../docs/builder/README.md) for the shared model.

## Delegation

In development. Job submission, job following, and the per-verb delegation
methods are not yet available. The operation consumption primitive is in place:
`Semiont.Running` exposes an opaque `Running report result`.

Constructing an operation starts no work. `await` starts it and returns its
terminal result; `withReports` instead supplies a `Stream (Of report) IO result`
from the `streaming` package. Only one consumer may start an operation, once.
Producer failures propagate to the consumer. Leaving `withReports` cancels
and joins the producer, and a stream retained past that scope refuses reads.

## Live queries

In development. The cache, one-shot fresh reads, invalidation, and persisted
query values are not yet exposed. They will follow the shared
[cache contract](../../../protocol/contract/CACHE-SEMANTICS.md). The internal
observation primitive already supports ordered independent subscriptions,
atomic initial state, repeated equal notices, and scoped cancellation.

## State units

In development. The coordinated flow and page state APIs described in
[State units](../../../docs/builder/STATE-UNITS.md) are still to be implemented.

## Running a worker

`Semiont.JobFilter.jobMatchesFilter` compares a typed `JobFilter` with a job's
JSON representation, including queued events and claimed job descriptions.
It compares every field the filter states at the same path; other fields do
not affect the match. `Semiont.Claims.willRetryAfter` takes the job's metadata
before applying a failure and its optional `FailureClass`. Its answer follows
the shared job retry cases: deterministic and withheld failures do not retry;
transient and unclassified failures retry while the record has budget left.

`Semiont.Claims.jobClaimChannels` and `jobCommitChannels` give a worker the
channels to subscribe to for claiming and committing. They are generated from
the existing SDK's worker channel declarations and the typed bus descriptors.

`Semiont.Worker` claims one job at a time. `newClaims` is lazy: the first
`next` starts claiming, and the worker claims again after settlement, a
matching announcement while idle, or a stream reopening. Bracket it with
`stop` so a job still held when the worker stops is failed for retry before
the transport closes.

```haskell
{-# LANGUAGE GADTs #-}
module WorkerExample where

import Control.Exception (bracket)
import qualified Semiont.Client as Client
import qualified Semiont.Worker as Worker
import Semiont.Types (MarkJobResult, YieldJobResult)

runWorker :: Client.Client -> Worker.WorkerOptions
  -> (Worker.HeldJob MarkJobResult -> IO MarkJobResult)
  -> (Worker.HeldJob YieldJobResult -> IO YieldJobResult)
  -> IO ()
runWorker client options mark yield =
  bracket (Worker.newClaims (Client.transport client) options) Worker.stop loop
  where
    loop claims = do
      next <- Worker.next claims
      case next of
        Nothing -> pure ()
        Just (Worker.HeldMark job) -> do
          Worker.start job
          mark job >>= Worker.complete job
          loop claims
        Just (Worker.HeldYield job) -> do
          Worker.start job
          yield job >>= Worker.complete job
          loop claims
```

`WorkerOptions` supplies a nonempty list of generated filters, `BusOptions`
for monotonic time and correlation ids, generated timing settings, and a wall
clock that returns ISO 8601 timestamps. The transport must subscribe to
`jobClaimChannels`, plus `jobCommitChannels` when the worker commits annotations.

A held job exposes the claimed record's identity, parameters, retry budget,
completed units and unit cursors. Its `cancelled` and `settled` observations
are read-only STM actions. The worker's code watches cancellation and calls
`cancel` after its work has stopped. `progress` and `checkpoint` report activity;
`complete`, `fail` and `cancel` settle once, releasing the job even if sending
the outcome fails. A mark job's completion accepts only `MarkJobResult`, and a
yield job's only `YieldJobResult`.

`commit` waits for the record's acknowledgement. If it times out, it probes
the batch's last annotation once instead of sending the batch again. Settlement
reports the weakest durability evidence observed. Supply stable annotation ids
across attempts, and count a unit completed only after its commit is established.

Use the scoped `refused` and `stalled` streams for faults the host must judge,
and `vitals` for activity snapshots. An empty queue is not a refusal. `trace`
exposes the carrier that handed over the job; a host exporting telemetry uses
that carrier as the parent of its own job span. Claims start outside the trace
of the previous job. The shared
[worker contract](../../../protocol/contract/WORKER-CONTRACT.md) states these
lifetimes and observations.

## Several knowledge bases

`Semiont.HostName.isValidHostname` checks the host names an HTTP endpoint may
use. `Semiont.Gateway.gatewayUrl` validates a typed `HttpEndpoint` and returns
its origin, with the host in lowercase and an explicit port. Invalid host
names are refused before they become part of a URL.

`Semiont.Discovery` reads a launcher's entire document and distinguishes an
absent launcher from one managing no knowledge bases. Its types and absent
reasons are derived from the protocol. Use `textDiscovery` over an application
reader, for example a launcher file:

```haskell
module Main (main) where

import qualified Data.Text.IO as Text
import Semiont.Discovery (readDiscovery, textDiscovery)

main :: IO ()
main = do
  found <- readDiscovery
    (textDiscovery (Text.readFile "/path/to/launcher-state/discovery/kbs.json"))
  print found
```

This program also needs `text` in its `build-depends`. `discoveryDiff` compares
entries by address, keeps separate copies with the same DID, and reports
duplicate address claims. `subscribeDiscovery` polls with the monotonic time,
interruptible absolute wait, and interval supplied through `DiscoveryOptions`.
Stopping consumption leaves no polling task running.

Registry, knowledge-base selection, session persistence, and the SDK's HTTP
discovery adapter are still being implemented. Reading a discovery document
does not sign in to any of its knowledge bases.

## IDs and protocol types

Import models from `Semiont.Types`. Distinct identifier types expose checked
makers such as `mkResourceId`; their constructors are hidden. JSON decoders
apply the same protocol constraints. Optional nullable properties use
`Semiont.Types.Presence`, whose `Absent`, `Null`, and `Present` cases preserve
JSON membership. Other optional properties use `Maybe`.

Records preserve extra members when their schema permits them. Closed enums
and unions are algebraic types. JSON numbers use `Integer` or `Scientific`,
and date and URI values retain their `Text` spelling.

`Semiont.Channels` provides GADT descriptors. Each channel has its own payload
type and scope kind; each operation fixes its request, result, and failure
types. The typed bus requires `InScope resourceId` when observing a
resource-scoped channel.

## Errors and retry

`Semiont.ErrorCodes` derives closed error vocabularies and wire/HTTP status
classifiers from the protocol. `Semiont.Timing` derives the timing constants
and retry budgets.

`Semiont.Retry` provides retry decisions, `Retry-After` parsing, and
`retryWithBackoff`. Its `RetryOptions` requires caller-supplied monotonic
nanoseconds, an interruptible wait to an absolute deadline, and non-secret
jitter. Cancellation is preserved, each retry respects the server's stated
wait, and the last failure is raised when the budget is exhausted.

## The bus and transport

`Semiont.Transport.newTransport` gives a carrier its input handle and the
transport its consumers use. The carrier supplies sending and teardown, feeds
received frames through `receive`, and publishes valid connection transitions
through `setState`. Its subscription snapshot contains the current resource
holds and pending correlations. `Semiont.StateValue` exposes state observations
without a public setter.

Build a `Semiont.Bus` with `newBus`, a transport, and `BusOptions`. The options
supply monotonic time, an interruptible absolute wait, and fresh correlation
IDs. Each request waits for the stream to open, tracks its reply before sending,
emits once, and ends on a reply, deadline, cancellation, or transport close.
For example, given a bus and a typed command:

```haskell
module ProtocolCalls (addEntityType) where

import qualified Semiont.Bus as Bus
import qualified Semiont.Channels as Channels
import qualified Semiont.Timing as Timing
import Semiont.Types (EmptyBusPayload, FrameAddEntityTypeCommand)

addEntityType :: Bus.Bus -> FrameAddEntityTypeCommand -> IO EmptyBusPayload
addEntityType wire command =
  Bus.request wire Channels.FrameAddEntityTypeOperation command
    Timing.busRequestTimeoutMs
```

`Bus.frames` requires `InScope resourceId` for a resource channel and holds that
scope until its reader leaves. It yields `Heard delivered` or `Refused refusal`
in order, and continues after a refusal. Deliveries retain their emitter,
envelope, and trace; a refusal keeps the raw frame and the missing-member path
when it is known. The trace field is lifted out of the payload.

`Semiont.EventBus` is the client's separate local plane. A transport bridge
publishes raw replies there before request continuations can emit derived
signals. Detach a bridge through its returned release action. Closing a
transport completes its observations, ends pending requests, and joins its
callback workers; closing from one of those callbacks does not join itself.

The HTTP adapter reconnects with bounded backoff, drains the old stream during
scope handoffs, deduplicates overlap, and loads/saves per-resource replay
positions through the supplied callbacks. Credential renewal receives the
refused token; a credential refused again is quarantined until the host supplies
a usable one. Ordinary reads retry once when eligible, and an unanswered request
at its own deadline fails without another attempt.

## Telemetry

The SDK uses the application's OpenTelemetry tracer/meter providers and text-map
propagator. It creates no provider or exporter. Bus sends and receives, uploads,
and content reads record the spans and counter declared by the shared telemetry
table. Outgoing HTTP requests carry the host's injected headers; incoming frames
are processed under its extracted context. Caller context also crosses request
work, operation producers and callback tasks using the standard propagation API.

## Building and verifying

From the repository root, build and test in Apple `container`:

```sh
bash packages/haskell/run-container.sh
```

CI runs the same entry point with `docker` as its argument. The compiler and
Cabal pins are shared with [the design probes](../probes/README.md); exact
project dependencies are frozen. Ordinary builds use checked-in generated
files and require no npm or schema generation.

The runner also builds `conformance/bin/semiont-haskell-wire-driver`. The shared
[wire suite](../../../protocol/conformance/sdk/README.md) drives that executable
through the public SDK against the real gateway on both signal planes, including
OTLP export. CI transfers the tested driver to the SDK Conformance job.

Inside the development container, from this package directory:

```sh
cabal run semiont-codegen -- /work
cabal build all --enable-tests --enable-coverage -j1
python3 api.py --write
bash run.sh /work
```

Here `/work` is the repository root. The Haskell generator derives protocol
types, channel descriptors, error codes, timing, the module list, and the
package version. Refresh `public-api.json` after library source changes;
GHC supplies the reachable types, constructors, and signatures through the
public Cabal modules, including re-exports. The census checks source
freshness; the Haskell job compares actual compiled exports. Integration
with every shared client-surface section is still open.

### What the checks cover

The schema suite generates samples from the schema definitions, checks JSON
round trips, absence/null behavior, closed enums, exact large numbers, and
permitted extra members. It also executes the shared identifier table and
every shared job-filter, job-retry, and gateway URL case, and checks resolved
JSON payloads from the wire, live-query, and worker corpora.
The wire driver additionally executes the transport scenarios against the real
gateway on both signal planes. The worker driver runs every worker case against
the real gateway on both planes as well. The live-query driver remains outstanding.

Runtime tests also cover atomic publication of raw replies before request
continuations, channel/correlation matching, tracking cleanup on cancellation,
close waking pending requests, SSE chunk boundaries, and operation ownership.

See [the design probe results](../probes/README.md) for the measured HTTP,
resource-lifetime, telemetry, crypto, and native-lock behavior.

## License

[Apache-2.0](LICENSE).
