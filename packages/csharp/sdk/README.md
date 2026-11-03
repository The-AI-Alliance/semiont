# Semiont SDK for .NET

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=csharp-sdk)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

Under construction. Models and checked identifiers are generated from the protocol schemas
during compilation. The HTTP transport and wire conformance driver are implemented; the
session and high-level client are next. Nothing is published to NuGet. Consumers will use
a project reference until publishing is enabled separately.

The SDK targets .NET 11. [global.json](global.json) pins the SDK exactly, with roll-forward
disabled. [dotnet-version.sh](../scripts/dotnet-version.sh) derives the container
tag from that version. No .NET installation on the host is required.

From the repository root, build and check inside Apple `container`:

```sh
container run --rm --memory 4g -v "$PWD":/work -w /work/packages/csharp/sdk \
  "mcr.microsoft.com/dotnet/sdk:$(packages/csharp/scripts/dotnet-version.sh --image-tag)" \
  sh -c 'dotnet build -p:RestoreLockedMode=true && dotnet test --no-build --settings test.runsettings && dotnet format --no-restore --verify-no-changes'
```

The build enables nullable reference types, warnings as errors, analyzers, and explicit
accessibility. Its Roslyn census analyzer covers generated code too. It refuses null
forgiveness, task blocking, dynamic types, diagnostic suppression, skipped tests, and
environment reads other than `SEMIONT_BUS_LOG`. The analyzer is a build-time dependency;
the SDK has no runtime package dependencies.

Every build compiles each file in [refusals](refusals) separately and requires its stated
diagnostic. The xUnit suite checks valid code that must remain accepted. The test settings
make a run with no tests fail. Linux CI uploads Cobertura coverage under `csharp-sdk`;
Windows CI builds, tests, and checks formatting as well.

The incremental generator reads `protocol/specs/src` as compiler additional files. It emits sealed
records, closed record unions, wire enums, and checked identifier structs. Unknown schema
keywords fail compilation with `SEMGEN001`. Generated code is not checked in.

Use `Semiont.Types` for models and `Semiont.Identifiers` for identifier kinds. Optional
nullable members use `Stated<T>` to distinguish absence from explicit null. Open objects
retain unknown members as `JsonElement`; dates and URIs retain their wire spelling.
Tests round-trip resolved payloads from the shared wire, live, and worker corpora.

`Semiont.Http.HttpTransport` carries SSE frames, emits, and correlated requests. It
supports resource holds, reconnects with per-resource watermarks, event deduplication,
credential renewal, and cancellation. Each frame observer has its own queue; a view of
several channels preserves their delivery order. `HttpContentTransport` uploads multipart
content and reads resource bytes, descriptions, annotations, and anchored text.

The transport accepts a caller-owned `HttpClient`. Its own HTTP handler uses no proxy.
Deadlines and backoffs use the public `TimeProvider` and `Random` constructor arguments;
the defaults are `TimeProvider.System` and `Random.Shared`. Disposing the transport ends
its observers and requests and leaves a caller-owned HTTP client usable. Errors share
`Semiont.Errors.SemiontError`, with distinct transport and bus-request families.

Telemetry uses BCL `ActivitySource` and `Meter`; the application chooses its exporter.
`SEMIONT_BUS_LOG` enables payload logging to stderr, with credentials withheld according
to the shared bus-log table. See [the wire driver](conformance/README.md) for self-contained
builds and black-box conformance.
