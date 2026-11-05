# Semiont SDK for .NET

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=csharp-sdk)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

Add a project reference to [Semiont.csproj](src/Semiont/Semiont.csproj) until the NuGet
package is published. Models and checked identifiers are generated from the protocol
schemas during compilation.

Construct `SemiontClient` with a gateway URL and token. Its eight verb namespaces are
`Yield`, `Mark`, `Bind`, and `Frame` for writes, `Browse`, `Match`, and `Gather` for
reads, and `Beckon` for attention. The PascalCase property `Yield` can be used directly
in C# because the contextual keyword is spelled `yield`.

Frame mutations await their replies.
A batch of entity types sends each mutation after the preceding one settles.
The client disposes its transport, and a supplied HTTP client stays caller-owned.

`client.Wire` accepts generated `BusChannels` and `BusOperations` values.
A typed request returns the channel's declared reply model. A typed read
gives a `Heard<T>` value for each frame, with its envelope and trace context.
Malformed payloads yield a refusal and the read continues. A scoped read
keeps its resource subscribed until the enumerator ends.

`client.Bus` carries local signals and receives frames from the wire.
Read an existing resource scope through the local bus, or use
`client.Wire.Frames` to hold the scope during the read. Bind initiation and
Beckon hover and sparkle stay local. Beckon attention and its other remote
signals return the gateway's subscriber count when it can count observers.

`client.Mark.Delegate(resourceId, parameters)` follows an annotation job, and
`client.Yield.Delegate(parameters)` follows generation from a gathered context.
Await a delegation for its typed completion, or use `await foreach` to see the
job ID, progress, retryable failures, and completion in order. Each delegation
can be consumed once. Leaving a read stops following the job. Yield's optional
stall deadline applies to the follower, which asks the queue to cancel the job
if it stops reporting. A `JobError` carries the shared error code, job ID when
known, and failure class when the worker supplied one.

Gather a resource's context, then delegate a generation grounded in that context.
Call `RunAsync` from your program with the gateway URL, a current access token,
and the source resource ID. The example owns its client and passes the cancellation
token to both operations.

```csharp
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Semiont;
using Semiont.Identifiers;
using Semiont.Types;

public static class GatherAndDelegate
{
    public static async Task<YieldJobCompleteCommand> RunAsync(
        string endpoint, string token, ResourceId source, string storageUri,
        HttpClient? http = null, CancellationToken cancellation = default)
    {
        using var client = new SemiontClient(endpoint, token, http);
        var context = await client.Gather.ResourceAsync(source, cancellation: cancellation);
        var generation = client.Yield.Delegate(new GenerationJobParams
        {
            Context = context,
            Title = "Notes",
            StorageUri = storageUri,
        });
        return await generation.CompleteAsync(cancellation);
    }
}
```

## Running a worker

Create a `ServiceToken` with your service account credentials and keep it alive
while the worker runs. `AgentToken.SignInAsync` confirms the agent's identity
with the gateway. Give the transport the initial token, use `TokensChanged` to
keep it current, and pass `RefreshAsync` to handle a gateway refusal.

`Claims.NextAsync` returns the next job, or `null` when claiming ends. The
example starts each job and calls your handler. Complete a `HeldMarkJob` or
`HeldYieldJob` with the result for its verb, or settle it with `FailAsync` or
`CancelAsync`. Read the job's attempt and saved checkpoint when resuming work.
Use its `Trace` as the parent of the job's activity. The example awaits
`StopAsync` before closing the client so the worker can report any job it
still holds.

```csharp
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Semiont;
using Semiont.Http;
using Semiont.Jobs;
using Semiont.SignIn;
using Semiont.Types;

public static class RunWorker
{
    public static async Task RunAsync(HttpEndpoint endpoint, ServiceToken service,
        IReadOnlyList<JobFilter> filters, Func<IHeldJob, CancellationToken, Task> settle,
        bool commitsAnnotations = false, HttpClient? http = null,
        CancellationToken cancellation = default)
    {
        using var agent = new AgentToken(endpoint, service, http);
        await agent.SignInAsync(cancellation);

        var channels = commitsAnnotations
            ? WorkerRules.JobClaimChannels.Concat(WorkerRules.JobCommitChannels)
            : WorkerRules.JobClaimChannels;
        using var client = new SemiontClient(new HttpTransport(agent.Gateway, agent.Token,
            channels, refresher: agent.RefreshAsync, httpClient: http));
        using var updates = new CancellationTokenSource();
        var following = FollowTokensAsync(agent, client.Transport, updates.Token);
        var claims = client.Job.Claim(filters);
        try
        {
            while (await claims.NextAsync(cancellation) is { } job)
            {
                using var running = CancellationTokenSource.CreateLinkedTokenSource(cancellation, job.Cancelled);
                try
                {
                    await job.StartAsync(running.Token);
                    await settle(job, running.Token);
                    if (!job.Settled) throw new InvalidOperationException("The worker must settle its job.");
                }
                catch (OperationCanceledException) when (job.Cancelled.IsCancellationRequested && !cancellation.IsCancellationRequested)
                {
                    if (!job.Settled) await job.CancelAsync(cancellation: cancellation);
                }
            }
        }
        finally
        {
            try { await claims.StopAsync(); }
            finally
            {
                updates.Cancel();
                await following;
            }
        }
    }

    private static async Task FollowTokensAsync(AgentToken agent, HttpTransport transport, CancellationToken cancellation)
    {
        try
        {
            await foreach (var _ in agent.TokensChanged(cancellation)) transport.SetToken(agent.Token);
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { return; }
    }
}
```

## Reading and writing resources

Browse reads resource text, bytes, streams, graphs, anchored text, history, and
knowledge base metadata. Dispose a representation stream when finished with it.
`Yield.Resource` starts an upload immediately. Read its progress once and await
the upload for the created resource. Dispose an upload to abandon its request.
`Yield.CreateFromTokenAsync` reads the source first and uploads the copy in a
format that can be authored, using plain text for other formats.

Live reads such as `Browse.Resource` share a cache by key. A resource observer
holds that resource's event subscription until the enumerator ends. Refreshes
keep the last value visible while the new request runs. Use `FreshAsync` on the
query when you need a new answer for a one-off read.

```csharp
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Semiont;
using Semiont.Identifiers;
using Semiont.Types;

public static class WatchResource
{
    public static async Task RunAsync(SemiontClient client, ResourceId resourceId,
        TextWriter output, CancellationToken cancellation = default)
    {
        await foreach (var state in client.Browse.Resource(resourceId).WithCancellation(cancellation))
        {
            var message = state switch
            {
                CacheState<ResourceDescriptor>.Pending => "Loading…",
                CacheState<ResourceDescriptor>.Ready(var resource) => resource.Name,
                CacheState<ResourceDescriptor>.Failed(var error) => error.Message,
            };
            await output.WriteLineAsync(message);
        }
    }
}
```

The switch covers the cases of the SDK's closed cache-state type. When the SDK
adds a case, recompiling the switch points out the missing branch.

The SDK uses `IAsyncEnumerable<T>` and has no Rx dependency. To consume a
stream as an observable, reference `System.Interactive.Async` in the host
project and import `System.Linq`. Then call
`client.Browse.Resource(resourceId).ToObservable()`.

Supply `CachePersistence` when constructing a client to keep selected values
and their replay bookmarks across sessions. Use a separate document for each
knowledge base and principal. Its `Write` callback should replace the whole
document atomically. A restored value is visible immediately and revalidated
when first read.

State units in `Semiont.State` expose read-only `StateValue<T>` properties.
Read `Value` for a snapshot or enumerate the property to receive the current
value followed by updates. Dispose the unit to stop its work and end its streams.
`SemiontSession` owns the kept-session lifecycle and leaves its client with its caller.
See the [state-unit contract](../../../docs/builder/STATE-UNITS.md).

`Semiont.Registry.SemiontBrowser` keeps registered knowledge bases, the active
session, and open resources. Give it an `ISessionStorage` and a session factory,
such as `HttpSessionFactory`, then hold it with `await using`. `MemoryStorage`
lasts for the process. A shared store implements atomic `Update` and sends
`Subscribe` notifications for writes from other contexts.

`BrowserSignIn.BeginSignInAsync` gives the authorization URL with PKCE.
Pass the callback URL to `CompleteSignInAsync` once. It exchanges the code
and asks the gateway for its knowledge-base identity before storing credentials.
`LauncherDiscovery` reads the launcher's discovery document through HTTP
or a caller-provided text reader and streams changes by address.

`Semiont.Annotations.AnnotationTools` reads annotation bodies and selectors,
reconciles a quote against its source, and builds annotations from a whole resource,
plain text, or PDF anchored text. Spans count Unicode code points. The builders
derive the same ID when they are given the same resource, motivation, span, and body.

## Testing a composition

`Semiont.Testing` is part of the SDK assembly. Use `TestSessions.CreateTestSessionAsync`
for a real client and offline session. Call `SetToken` to simulate a live sign-in.
`FaultyTransport` scripts the bus over HTTP and SSE, with a request log and faults
for drops, delays, duplicates, and emit refusal. Queue responses by operation or
provide a `Respond` delegate. Use its `Other` handler for content endpoints.

`Liveness.AssertLivenessAxiomsAsync` runs a fresh composition for each fault schedule
and checks that its output speaks and awaited paths settle within a bounded time.
`Liveness.AssertExactlyOnceDeliveryAsync` checks that writes survive connection
transitions exactly once. Use a seeded `Random` with `FaultSchedules` and
`DeliveryOps` to replay the generated cases. For registry tests, `ScriptedSessions`
supplies gateway answers, identity and renewal. `SharedStorage.Context()` creates
another view of the same storage that hears writes from other contexts.

## Building and verifying

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

## Signing in

`Semiont.SignIn.SignInStore` reads and updates the launcher's sign-ins. Give it an
explicit state directory; `StateDirectory` computes that path from values supplied by
the application and reads no environment variables. `Entry(stackKey)` returns the kept
sign-in for that stack; `MemorySignIn` keeps one in memory instead. Changes use the
launcher's native lock and atomic rename, preserve unknown entries and fields, and
keep the directory and credential files private to their owner.

`Issuer.RenewAsync(kept, holding)` exchanges the stored refresh token at its stored
endpoint. It adopts another writer's usable renewal before spending a refresh token,
preserves a renewal made during its grant, and never resurrects an entry signed out
meanwhile. A missing refresh token in the issuer's answer preserves the one spent.
Issuer refusal produces `SignInError`; transient failures use the shared retry budget.
It accepts a caller-owned `HttpClient`, `TimeProvider`, and `Random`, and disposal
cancels its pending grants without disposing the caller's client. The session layer
will decide whether an issuer refusal ends a session; the issuer itself retains the
kept entry when a grant fails.

`Semiont.Session.KeptSession` starts from an HTTP endpoint and an `ISignInKept`.
Await `ReadyAsync()` for startup to settle, then read `State` or enumerate
`States()` for the current token and gateway-validated user. An empty store
or failed startup can leave either value absent. Read `Errors()` for startup
errors. An expired credential is renewed
before validation; a refused credential is renewed once and validated once more.
`RefreshAsync(refusedToken)` handles a transport refusal; simultaneous callers share
one renewal, and canceling a caller's wait leaves that renewal running for the others.
Transient renewal failure retains the kept sign-in and retries on the reconnect backoff.
`EndReason` distinguishes issuer expiry from gateway refusal of a newly issued token;
`Errors()` reports the generated session error codes. Disposal cancels owned work and
completes observers without signing out the kept credentials.

Use `HttpSessionFactory` with `SemiontBrowser` to bind a registered knowledge
base's session to its client. When building the client yourself, pass
`kept.RefreshAsync` as the `HttpTransport` refresher and subscribe the
transport to the result and failure channels for the operations you call.
A `SemiontSession` over that client and kept session applies credential
updates to the transport. Dispose the session before closing the client.

`Gateway.Origin(endpoint)` validates the host and preserves the explicit port.
`Gateway.GetCurrentUserAsync(origin, token)` asks who a token is with exactly one
request, without opening a stream, retrying the request, or renewing the token.

`Issuer.SignInDeviceAsync(endpoint, kept, onCode)` discovers the issuer the gateway
trusts and begins a device sign-in. The callback receives the user code and verification
address for the application to display. Polling follows the issuer's interval and
slow-down replies, expires on the supplied clock, and stops on cancellation or issuer
disposal. A successful grant saves the access and refresh tokens in `kept`.
Use that same entry when constructing a `KeptSession`.
`Issuer.SignOutAsync(kept)` attempts revocation and forgets the local credentials even
when the issuer cannot be reached. Discovery rejects an issuer document that describes
a different issuer or provides invalid endpoint addresses.

`ServiceToken` gives a service account's bearer header through
`AuthorizationAsync`. Supply its issuer, client ID, and either a client secret
or an RSA private key. The service discovers the endpoint once and shares an
in-flight grant among callers. The caller keeps any supplied key and HTTP client
usable for the service token's lifetime.

`AgentToken` uses a service token to sign in to a knowledge base and confirm
its DID. It renews the token when due or after a credential refusal.
`RefreshAsync` can serve as a transport refresher, and `TokensChanged` exposes
updates to consumers. Dispose the agent before disposing its service token.

`Semiont.Session.Identity` derives a knowledge base's DID and token audience
from its domain. It also derives person and agent DIDs from issuer subjects,
encoding each subject as one DID segment.

HTTP response retries follow the shared boot, transport, and refresh rules.
The transport honors a whole-seconds `Retry-After` header. The separate job
retry rule belongs to the worker.
