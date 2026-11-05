# Semiont Haskell SDK

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=haskell-sdk)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

Development is in progress on one branch toward the complete SDK. The current
package provides protocol-derived models, checked identifiers, typed
channel/operation descriptors, and scoped operation consumption. The client, HTTP transport, sign-in, delegation,
live queries, workers, registry, and state units remain to be implemented.

The package is not published. Publishing is outside the current implementation
scope.

## Build and generation

Build and test inside the development container. The compiler and Cabal pins
are shared with `../probes`; exact project dependencies are frozen locally.

```sh
# Inside the container, from this directory:
cabal run semiont-codegen -- /work
cabal build all --enable-tests -j1
cabal test schema-cases --test-show-details=direct --test-options=/work
cabal run semiont-codegen -- --check /work
```

Here `/work` is the repository root. Ordinary builds use the checked-in
generated files and require no npm or schema generation. The generator is a
Haskell executable in the package; it needs the repository inputs only when
run. It derives the module list and package version as well as the models.

After changing library sources, build the library and run `python3 api.py
--write` inside the container to refresh `public-api.json`. GHC supplies the
reachable types, constructors, and signatures through the public Cabal modules,
including re-exports. The repository census checks source freshness; the Haskell
job independently compares the installed library's actual exports with the
snapshot. Integration with every shared client-surface section is still open.

## Types and identifiers

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

## Operation consumption

`Semiont.Running` exposes an opaque `Running report result`. Constructing an
operation starts no work. `await` starts it and returns its terminal result;
`withReports` instead supplies a `Stream (Of report) IO result` from the
`streaming` package. Only one of those consumers may start the operation, once.
Producer failures propagate to the consumer, and leaving `withReports` cancels
and joins the producer. A stream retained past that scope refuses further reads.
The namespace methods that create these handles are still in development.

## Validation

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
