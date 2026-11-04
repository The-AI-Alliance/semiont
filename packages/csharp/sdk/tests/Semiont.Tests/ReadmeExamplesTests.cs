using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Channels;
using Semiont.SignIn;
using Semiont.Testing;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

public sealed partial class TransportTests
{
    [Fact]
    public void EveryCSharpReadmeBlockMatchesAnExample()
    {
        var readme = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "SDK-README.md")).ReplaceLineEndings("\n");
        var blocks = Regex.Matches(readme, @"(?m)^```csharp\n([\s\S]*?)^```$").Select(match => match.Groups[1].Value.TrimEnd()).ToArray();
        var examples = Directory.GetFiles(Path.Combine(AppContext.BaseDirectory, "Examples"), "*.cs").Order(StringComparer.Ordinal)
            .Select(path => File.ReadAllText(path).ReplaceLineEndings("\n").TrimEnd()).ToArray();
        Assert.Equal(examples, blocks);
    }

    [Fact]
    public async Task ReadmeExampleGathersThenCompletesADelegation()
    {
        var gathered = BusOperations.GatherResourceRequested.Request.Name;
        var create = BusOperations.JobCreate.Request.Name;
        var seenCreate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var context = GenerationParameters().Context;
        using var gateway = new FaultyTransport(respond: (operation, _) =>
        {
            if (operation == gathered) return JsonSerializer.SerializeToElement(context);
            Assert.Equal(create, operation);
            seenCreate.TrySetResult();
            return JsonSerializer.SerializeToElement(new JobCreatedResultResponse { JobId = DelegatedJob });
        });
        using var http = new HttpClient(gateway, disposeHandler: false);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var pending = GatherAndDelegate.RunAsync("http://unit.test", "test", DelegatedResource, "file://notes.md", http, deadline.Token);
        if (await Task.WhenAny(pending, seenCreate.Task).WaitAsync(deadline.Token) == pending) await pending;
        var done = new YieldJobCompleteCommand { JobId = DelegatedJob, ResourceId = DelegatedResource };
        gateway.Deliver(new BusFrame
        {
            Channel = BusChannels.JobComplete.Name,
            Payload = JsonSerializer.SerializeToElement<JobCompleteCommand>(new JobCompleteCommand.YieldJobCompleteCommandCase(done)),
        });
        Assert.Equal(done, await pending);
        Assert.Equal(new[] { gathered, create }, gateway.RequestLog.Select(entry => entry.Operation));
    }

    [Fact]
    public async Task ReadmeExampleWatchesALiveResource()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var resource = SourceResource();
        using var gateway = new FaultyTransport(respond: (operation, _) =>
        {
            Assert.Equal(BusOperations.BrowseResourceRequested.Request.Name, operation);
            return JsonSerializer.SerializeToElement(new { resource, lastSequence = 1 });
        });
        using var session = await TestSessions.CreateTestSessionAsync(new(Transport: gateway), deadline.Token);
        session.SetToken("test");
        using var writer = new LineWriter();
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token);
        var watching = WatchResource.RunAsync(session.Client, resource.Id, writer, stop.Token);
        Assert.Equal("Loading…", await writer.Lines.Reader.ReadAsync(deadline.Token));
        Assert.Equal(resource.Name, await writer.Lines.Reader.ReadAsync(deadline.Token));
        stop.Cancel();
        await watching.WaitAsync(deadline.Token);
    }

    [Fact]
    public async Task ReadmeWorkerRefreshesARefusedTokenAndSettlesTheHeldJobOnStop()
    {
        var grants = 0;
        using var gateway = new Handler
        {
            EmitStatus = token => token == "first-token" ? HttpStatusCode.Unauthorized : HttpStatusCode.Accepted,
            Other = (request, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = request.RequestUri?.AbsolutePath switch
                {
                    "/.well-known/openid-configuration" => JsonContent.Create(new
                    {
                        issuer = "https://issuer.example",
                        authorization_endpoint = "https://issuer.example/authorize",
                        token_endpoint = "https://issuer.example/token",
                    }),
                    "/token" => JsonContent.Create(new
                    {
                        access_token = Interlocked.Increment(ref grants) == 1 ? "first-token" : "renewed-token",
                        expires_in = 60,
                    }),
                    "/api/users/me" => JsonContent.Create(new
                    {
                        did = "did:web:kb.example:agents:worker",
                        domain = "kb.example",
                        email = (string?)null,
                        name = (string?)null,
                        image = (string?)null,
                    }),
                    _ => throw new InvalidOperationException("Unexpected request"),
                },
            }),
        };
        using var http = new HttpClient(gateway, disposeHandler: false);
        using var service = new ServiceToken("https://issuer.example", "worker", "secret", http);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token);
        var endpoint = new HttpEndpoint { Host = "kb.example", Port = 443, Protocol = HttpEndpointProtocol.Https };
        var filters = Required<JobFilter[]>(JsonSerializer.SerializeToElement(new[] { new { jobType = "mark", @params = new { motivation = "highlighting" } } }));
        var handling = new TaskCompletionSource<IHeldJob>(TaskCreationOptions.RunContinuationsAsynchronously);
        var worker = RunWorker.RunAsync(endpoint, service, filters, (job, cancellation) =>
        {
            handling.TrySetResult(job);
            return Task.Delay(Timeout.InfiniteTimeSpan, cancellation);
        }, http: http, cancellation: stop.Token);

        var (refused, firstToken) = await gateway.Emits.Reader.ReadAsync(deadline.Token);
        Assert.Equal(BusOperations.JobClaim.Request.Name, Text(refused, "channel"));
        Assert.Equal("first-token", firstToken);
        var (claim, renewedToken) = await gateway.Emits.Reader.ReadAsync(deadline.Token);
        Assert.Equal(BusOperations.JobClaim.Request.Name, Text(claim, "channel"));
        Assert.Equal("renewed-token", renewedToken);
        Reply(gateway, claim, BusOperations.JobClaim.Result.Name, new JobClaimedResult { Response = RunningMarkJob() });
        var (started, startToken) = await gateway.Emits.Reader.ReadAsync(deadline.Token);
        Assert.Equal(BusChannels.JobStart.Name, Text(started, "channel"));
        Assert.Equal(renewedToken, startToken);
        var held = await handling.Task.WaitAsync(deadline.Token);
        stop.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => worker.WaitAsync(deadline.Token));
        var (failed, stopToken) = await gateway.Emits.Reader.ReadAsync(deadline.Token);
        Assert.Equal(BusChannels.JobFail.Name, Text(failed, "channel"));
        Assert.Equal(renewedToken, stopToken);
        Assert.True(held.Settled);
        Assert.Equal(2, grants);
    }

    private sealed class LineWriter : StringWriter
    {
        internal Channel<string> Lines { get; } = Channel.CreateUnbounded<string>();

        public override Task WriteLineAsync(string? value)
        {
            Lines.Writer.TryWrite(value ?? "");
            return Task.CompletedTask;
        }
    }
}
