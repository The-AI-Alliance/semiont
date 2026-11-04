using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Channels;
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
