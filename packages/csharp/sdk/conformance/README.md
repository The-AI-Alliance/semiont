# C# conformance driver

`WireDriver` runs the shared [wire corpus](../../../../protocol/conformance/sdk/wire/)
through the SDK's public transport APIs. It uses the JSON-line protocol described in
[the suite](../../../../protocol/conformance/sdk/README.md), including concurrent
requests, cancellation, observed frames, connection states, failures, and upload progress.
With `--live`, the driver uses the public client to exercise cached queries and job
delegation against the shared [live corpus](../../../../protocol/conformance/sdk/live/).
With `--worker`, it claims and settles jobs through the public worker API for
the shared [worker corpus](../../../../protocol/conformance/worker/cases/).
The driver exports the SDK's BCL activities and metrics through an application-owned
OpenTelemetry provider. The SDK itself takes no OpenTelemetry package dependency.

From the repository root on an arm64 Mac:

```sh
container run --rm --memory 4g -v "$PWD":/work -w /work/packages/csharp/sdk \
  "mcr.microsoft.com/dotnet/sdk:$(packages/csharp/scripts/dotnet-version.sh --image-tag)" \
  dotnet publish conformance/WireDriver -c Release --self-contained \
  -r linux-arm64 -o conformance/bin -p:RestoreLockedMode=true
```

Use `linux-x64` for the Linux x64 CI runner. The solution restores both deployment
graphs so ordinary locked builds and self-contained publishes use the same lock files.
Analyzers, the generator, and the compiler-refusal runner stay host-compatible when
the application is published for another architecture.

Run the conformance suite in its Linux environment with Node, `nats-server`, a built
gateway, and this binary available. Its implementations file already names the C#
driver. No C# wire case is exempt.
