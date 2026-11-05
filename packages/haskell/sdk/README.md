# Semiont Haskell SDK

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=haskell-sdk)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

The Haskell SDK is being built toward the same client and protocol contract
as the other Semiont SDKs. It currently provides protocol types, checked
identifiers, typed channels, scoped operation consumption, retry support, and
launcher discovery.
The client, HTTP transport, sign-in, delegation, live queries, workers,
registry, and state units are still being implemented.

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

In development. The client facade, gateway HTTP transport, and content
transport are not yet available. The current package supports typed protocol
data and the operation primitives described below.

## Eight verbs

The Haskell client will implement the same namespaces and methods as the
[client surface](../../../protocol/specs/src/client/surface.json). Typed
channel and operation descriptors already exist in `Semiont.Channels`;
the namespace methods are still being implemented. See the
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

In development. Claims, held jobs, checkpoints, progress, settlement, and
durable commits are part of the full SDK scope. There is no public Haskell
worker API yet; the shared [worker contract](../../../protocol/contract/WORKER-CONTRACT.md)
states the behavior it will implement.

## Several knowledge bases

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
types. The runtime bus will require `InScope resourceId` when observing a
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

The current package has typed channel/operation descriptors and an internal
reply router. Runtime checks preserve raw-reply publication before request
continuations and keep the wire separate from local derived signals.
The public bus and HTTP transport are still being implemented.

## Telemetry

In development. The design probes verify host-owned OpenTelemetry providers,
propagation, and context across asynchronous work. Production transport and
client instrumentation remain to be implemented.

## Building and verifying

From the repository root, build and test in Apple `container`:

```sh
bash packages/haskell/run-container.sh
```

CI runs the same entry point with `docker` as its argument. The compiler and
Cabal pins are shared with [the design probes](../probes/README.md); exact
project dependencies are frozen. Ordinary builds use checked-in generated
files and require no npm or schema generation.

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
checks resolved JSON payloads from the wire, live-query, and worker corpora.
These model checks are distinct from executing the transport conformance
drivers, which remain to be built.

Runtime tests also cover atomic publication of raw replies before request
continuations, channel/correlation matching, tracking cleanup on cancellation,
close waking pending requests, SSE chunk boundaries, and operation ownership.

See [the design probe results](../probes/README.md) for the measured HTTP,
resource-lifetime, telemetry, crypto, and native-lock behavior.

## License

[Apache-2.0](LICENSE).
