using System.Text.Json;
using System.Text.Json.Nodes;
using Semiont.Errors;
using Semiont.Http;
using Semiont.Protocol;
using Semiont.Serialization;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

/// <summary>
/// The stream's reader, held to protocol/specs/src/bus/frame-cases.json: the table every SDK's stream reader runs. Each
/// case's line is carried on the stand-in gateway's stream, followed by a line that names no channel and a frame of
/// <c>beckon:focus</c> read cleanly. What the transport delivers, what a typed read of the case's channel is given, what
/// the failure report is told before that line, and what becomes of a request awaiting the case's reply are each held
/// to the case; the frame's coming shows the stream went on.
/// </summary>
public sealed partial class TransportTests
{
    /// <summary>The correlation id a request's case names the request awaiting its reply by.</summary>
    private const string AwaitedReply = "c-1";

    /// <summary>A line that names no channel: what the failure report is told after each case's line.</summary>
    private const string NamesNoChannel = "{";

    /// <summary>The frame each case's line is followed by, read cleanly.</summary>
    private const string FrameAfter = """{"channel":"beckon:focus","payload":{"resourceId":"after"}}""";

    public static TheoryData<string> FrameCases()
    {
        using var table = ReadSpec("bus/frame-cases.json");
        var cases = new TheoryData<string>();
        foreach (var row in table.RootElement.GetProperty("cases").EnumerateArray()) cases.Add(Text(row, "why"));
        return cases;
    }

    [Fact]
    public void TheFrameTableHasAFrameOfEachKind()
    {
        using var table = ReadSpec("bus/frame-cases.json");
        var cases = table.RootElement.GetProperty("cases").EnumerateArray().ToArray();
        var refused = cases.Where(row => row.TryGetProperty("refused", out _)).ToArray();
        Assert.NotEqual(cases.Length, refused.Length);
        Assert.Equal(["lacks", "malformed"], refused.Select(row => Text(row, "reason")).Distinct().Order(StringComparer.Ordinal));
        Assert.Equal(["failure-report", "readers"], refused.Select(row => Text(row, "told")).Distinct().Order(StringComparer.Ordinal));
        Assert.Equal(["fails", "waits"], refused.Where(row => row.TryGetProperty("request", out _))
            .Select(row => Text(row, "request")).Distinct().Order(StringComparer.Ordinal));
    }

    [Theory]
    [MemberData(nameof(FrameCases))]
    public async Task TheStreamReaderHoldsEachFrameToBusFrame(string why)
    {
        using var table = ReadSpec("bus/frame-cases.json");
        var stated = table.RootElement.GetProperty("cases").EnumerateArray().Single(row => Text(row, "why") == why);
        using var server = new Handler();
        using var http = new HttpClient(server);
        var replies = BusOperations.BrowseResourceRequested;
        using var transport = new HttpTransport("http://unit.test", "token",
            [BusChannels.BeckonFocus.Name, replies.Result.Name, replies.Failure.Name], httpClient: http);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(transport);

        if (!stated.TryGetProperty("refused", out _))
        {
            Assert.Equal(["frame", "why"], stated.EnumerateObject().Select(member => member.Name).Order(StringComparer.Ordinal));
            var frame = stated.GetProperty("frame");
            await using var delivered = new Reading<Carried>(transport.Frames(Text(frame, "channel"), deadline.Token));
            await using var failures = new Reading<SemiontError>(transport.Errors(deadline.Token));
            Carry(server, "e-1", JsonSerializer.Serialize(frame));
            Carry(server, "e-2", NamesNoChannel);
            var received = Assert.IsType<ReceivedBusFrame>(await delivered.NextAsync());
            Assert.True(JsonElement.DeepEquals(frame, Written(received.Frame)), "it is delivered as " + JsonSerializer.Serialize(Written(received.Frame)));
            AssertToldNoFrame(Fault.Undecoded, await failures.NextAsync());
            return;
        }

        var line = stated.TryGetProperty("data", out var data) ? data.GetString() : null;
        JsonNode? framed = stated.TryGetProperty("frame", out var shown) ? JsonNode.Parse(shown.GetRawText()) : null;
        Assert.Equal(new[] { "member", "reason", "refused", "told", "why", line is null ? "frame" : "data" }.Order(StringComparer.Ordinal),
            stated.EnumerateObject().Select(member => member.Name).Where(name => name is not ("correlationId" or "request")).Order(StringComparer.Ordinal));
        var fault = new Fault(Text(stated, "member"), stated.GetProperty("reason").Deserialize<FrameRefusalReason>());
        var replied = framed?["channel"] is JsonValue named && named.TryGetValue<string>(out var channelNamed) && channelNamed == replies.Result.Name;
        var channel = replied ? replies.Result.Name : BusChannels.BeckonFocus.Name;
        var correlation = stated.TryGetProperty("correlationId", out var carriedId) ? carriedId.GetString() : null;

        // A request's case awaits the reply its runner's request names: this one's requests choose their own ids, so its
        // frame carries the request's id in place of the table's.
        using var asking = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token);
        Task<JsonElement?>? request = null;
        if (stated.TryGetProperty("request", out _))
        {
            var frame = framed ?? throw new InvalidOperationException("A request's case carries a frame.");
            request = transport.RequestAsync(replies.Request.Name, JsonSerializer.SerializeToElement(new { resourceId = "res-1" }), cancellation: asking.Token);
            var (sent, _) = await server.Emits.Reader.ReadAsync(deadline.Token);
            var asked = Text(sent, "correlationId");
            if (frame["correlationId"] is JsonValue held && held.TryGetValue<string>(out var id) && id == AwaitedReply) frame["correlationId"] = asked;
            if (correlation == AwaitedReply) correlation = asked;
        }

        var bus = new Bus(transport);
        await using var carried = new Reading<Carried>(transport.Frames(channel, deadline.Token));
        await using var typed = new Reading<Heard<BeckonFocusEvent>>(bus.Frames(BusChannels.BeckonFocus, cancellation: deadline.Token));
        await using var typedReply = replied ? new Reading<Heard<BrowseResourceResult>>(bus.Frames(BusChannels.BrowseResourceResult, cancellation: deadline.Token)) : null;
        await using var told = new Reading<SemiontError>(transport.Errors(deadline.Token));
        Carry(server, "e-1", line ?? framed?.ToJsonString() ?? throw new InvalidOperationException("A case carries a frame or a line."));
        Carry(server, "e-2", NamesNoChannel);
        Carry(server, "e-3", FrameAfter);

        var read = await typed.BeforeAsync(heard => heard is Heard<BeckonFocusEvent>.Delivered { Payload.ResourceId.Value: "after" });
        // A reply's channel carries nothing but the case's line, and the frame after it is on another.
        List<Carried> came = replied ? [await carried.NextAsync()] : await carried.BeforeAsync(IsTheFrameAfter);
        switch (Text(stated, "told"))
        {
            case "readers":
                var frame = framed ?? throw new InvalidOperationException("A case told to its readers carries a frame.");
                var refusal = typedReply is null
                    ? Assert.IsType<Heard<BeckonFocusEvent>.Refused>(Assert.Single(read)).Refusal
                    : Assert.IsType<Heard<BrowseResourceResult>.Refused>(await typedReply.NextAsync()).Refusal;
                Assert.Equal((channel, fault.Member, fault.Reason), (refusal.Channel, refusal.Member, refusal.Reason));
                Assert.True(JsonNode.DeepEquals(frame["payload"], refusal.Payload is { } given ? JsonNode.Parse(given.GetRawText()) : null));
                Assert.Equal(frame["scope"]?.GetValue<string>(), refusal.Scope?.Value);
                Assert.Equal(correlation, refusal.CorrelationId);
                // A payload that is not its channel's is its typed reader's to refuse: the transport delivers its frame.
                if (fault.Member.StartsWith("payload.", StringComparison.Ordinal))
                {
                    var delivered = Assert.IsType<ReceivedBusFrame>(Assert.Single(came)).Frame.Payload;
                    Assert.True(JsonNode.DeepEquals(frame["payload"], JsonNode.Parse(delivered.GetRawText())));
                }
                else
                {
                    Assert.Equal(refusal, Assert.Single(came));
                }
                AssertToldNoFrame(Fault.Undecoded, await told.NextAsync());
                break;
            case "failure-report":
                Assert.Empty(came);
                Assert.Empty(read);
                AssertToldNoFrame(fault, await told.NextAsync());
                AssertToldNoFrame(Fault.Undecoded, await told.NextAsync());
                break;
            case var whom:
                throw new InvalidOperationException("told to whom the table does not give: " + whom);
        }

        if (request is null) return;
        switch (Text(stated, "request"))
        {
            case "fails":
                var failure = await Assert.ThrowsAsync<TransportError>(() => request.WaitAsync(deadline.Token));
                Assert.Equal(ProtocolFacts.Error(0), failure.Code);
                Assert.Equal("a frame on " + channel + " is not that channel's: " + fault, failure.Message);
                break;
            case "waits":
                Assert.NotSame(request, await Task.WhenAny(request, Task.Delay(TimeSpan.FromMilliseconds(100), deadline.Token)));
                asking.Cancel();
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => request);
                break;
            case var outcome:
                throw new InvalidOperationException("a request the table does not give: " + outcome);
        }
    }

    private static bool IsTheFrameAfter(Carried carried) =>
        carried is ReceivedBusFrame received && received.Frame.Payload.TryGetProperty("resourceId", out var resource) && resource.GetString() == "after";

    /// <summary>A <c>bus-event</c> line carrying <paramref name="data"/>, as the gateway's stream carries one.</summary>
    private static void Carry(Handler server, string id, string data) =>
        server.Stream.Push("id: " + id + "\nevent: bus-event\ndata: " + data + "\n\n");

    /// <summary><paramref name="frame"/> as the wire states one.</summary>
    private static JsonElement Written(BusFrame frame)
    {
        var written = new JsonObject { ["channel"] = frame.Channel, ["payload"] = JsonNode.Parse(frame.Payload.GetRawText()) };
        if (frame.CorrelationId is { } correlation) written["correlationId"] = correlation;
        if (frame.Scope is { } scope) written["scope"] = scope.Value;
        return JsonSerializer.SerializeToElement(written);
    }

    /// <summary>That <paramref name="failure"/> is what the failure report is told of a line with
    /// <paramref name="fault"/>.</summary>
    private static void AssertToldNoFrame(Fault fault, SemiontError failure)
    {
        var error = Assert.IsType<TransportError>(failure);
        Assert.Equal((ProtocolFacts.Error(0), (int?)null, "the stream carried what is not a frame: " + fault), (error.Code, error.Status, error.Message));
    }

    /// <summary>A reading of <paramref name="source"/> begun at once, so it hears what is carried from now on.</summary>
    private sealed class Reading<T> : IAsyncDisposable
    {
        private readonly CancellationTokenSource stop = new();
        private readonly IAsyncEnumerator<T> items;
        private Task<bool>? next;

        internal Reading(IAsyncEnumerable<T> source)
        {
            items = source.GetAsyncEnumerator(stop.Token);
            next = items.MoveNextAsync().AsTask();
        }

        internal async Task<T> NextAsync()
        {
            var moving = next ?? items.MoveNextAsync().AsTask();
            next = null;
            Assert.True(await moving, "the reading ended");
            return items.Current;
        }

        /// <summary>What came, up to the first that <paramref name="last"/> holds of, and without it.</summary>
        internal async Task<List<T>> BeforeAsync(Func<T, bool> last)
        {
            var read = new List<T>();
            for (var item = await NextAsync(); !last(item); item = await NextAsync()) read.Add(item);
            return read;
        }

        public async ValueTask DisposeAsync()
        {
            // A reading begun and never read is let go before its enumerator is.
            stop.Cancel();
            if (next is { } pending) await ((Task)pending).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
            await items.DisposeAsync();
            stop.Dispose();
        }
    }
}
