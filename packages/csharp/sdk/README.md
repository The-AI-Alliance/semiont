# Semiont SDK for .NET

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=csharp-sdk)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

Under construction. Models and checked identifiers are generated from the protocol schemas during compilation; the client is not yet
implemented. Nothing is published to NuGet. Consumers will use a project reference until
publishing is enabled separately.

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
