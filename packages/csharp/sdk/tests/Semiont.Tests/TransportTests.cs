using Semiont.Protocol;
using Semiont.Errors;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Extensions.Time.Testing;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

public sealed class TransportTests
{
    [Fact]
    public async Task AReplyCanArriveBeforeTheEmitReturns()
    {
        using var server = new Handler();
        using var client = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "secret", ["browse:resource-result", "browse:resource-failed"], httpClient: client);
        await OpenAsync(transport);
        server.Answer = body => server.Stream.Push("event: bus-event\ndata: {\"channel\":\"browse:resource-result\",\"correlationId\":" + body.GetProperty("correlationId").GetRawText() + ",\"payload\":{\"response\":{\"value\":3}}}\n\n");
        var result = await transport.RequestAsync("browse:resource-requested", JsonSerializer.SerializeToElement(new { resourceId = "r1" }));
        Assert.Equal(3, result?.GetProperty("value").GetInt32());
        var emit = await server.Emits.Reader.ReadAsync();
        Assert.Equal("secret", emit.Token);
        Assert.False(emit.Body.TryGetProperty("scope", out _));
    }

    [Fact]
    public async Task ThePublicClockOwnsRequestDeadlines()
    {
        var clock = new Clock();
        using var server = new Handler();
        using var client = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", ["browse:resource-result", "browse:resource-failed"], httpClient: client, timeProvider: clock);
        await OpenAsync(transport);
        var waiting = transport.RequestAsync("browse:resource-requested", JsonSerializer.SerializeToElement(new { resourceId = "r1" }), 1000);
        await server.Emits.Reader.ReadAsync();
        Assert.False(waiting.IsCompleted);
        await clock.TimerAsync(1000);
        clock.Advance(1000);
        var error = await Assert.ThrowsAsync<BusRequestError>(() => waiting);
        Assert.Equal("bus.timeout", error.Code);
    }

    [Fact]
    public async Task DisposeEndsWaitersAndObserversAndLeavesTheCallersClientUsable()
    {
        using var server = new Handler();
        using var client = new HttpClient(server);
        var transport = new HttpTransport("http://unit.test", "token", ["browse:resource-result", "browse:resource-failed"], httpClient: client);
        await OpenAsync(transport);
        await using var frames = transport.Frames("browse:resource-result").GetAsyncEnumerator();
        var next = frames.MoveNextAsync().AsTask();
        var waiting = transport.RequestAsync("browse:resource-requested", JsonSerializer.SerializeToElement(new { resourceId = "r1" }));
        await server.Emits.Reader.ReadAsync();
        transport.Dispose();
        transport.Dispose();
        Assert.Equal("bus.closed", (await Assert.ThrowsAsync<BusRequestError>(() => waiting)).Code);
        Assert.False(await next);
        using var response = await client.GetAsync("http://unit.test/still-owned");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task ListenerCancellationDoesNotStopAnotherListenerOrDeliverDuplicates()
    {
        using var server = new Handler();
        using var client = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", ["beckon:focus"], httpClient: client);
        await OpenAsync(transport);
        using var cancellation = new CancellationTokenSource();
        await using var first = transport.Frames("beckon:focus", cancellation.Token).GetAsyncEnumerator();
        await using var second = transport.Frames("beckon:focus").GetAsyncEnumerator();
        var firstRead = first.MoveNextAsync().AsTask();
        var secondRead = second.MoveNextAsync().AsTask();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => firstRead);
        server.Stream.Push("event: bus-event\nid: e-1\ndata: {\"channel\":\"beckon:focus\",\"payload\":{\"text\":\"héllo 🌱\"}}\n\n");
        Assert.True(await secondRead);
        Assert.Equal("héllo 🌱", second.Current.Payload.GetProperty("text").GetString());
        var following = second.MoveNextAsync().AsTask();
        server.Stream.Push("event: bus-event\nid: e-1\ndata: {\"channel\":\"beckon:focus\",\"payload\":{\"text\":\"duplicate\"}}\n\nevent: bus-event\nid: e-2\ndata: {\"channel\":\"beckon:focus\",\"payload\":{\"text\":\"next\"}}\n\n");
        Assert.True(await following);
        Assert.Equal("next", second.Current.Payload.GetProperty("text").GetString());
    }

    [Fact]
    public async Task SeveralChannelsShareOneOrderedView()
    {
        using var server = new Handler();
        using var client = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", ["beckon:focus", "beckon:sparkle"], httpClient: client);
        await OpenAsync(transport);
        await using var events = transport.Frames(new[] { "beckon:focus", "beckon:sparkle" }).GetAsyncEnumerator();
        var first = events.MoveNextAsync().AsTask();
        server.Stream.Push("event: bus-event\ndata: {\"channel\":\"beckon:sparkle\",\"payload\":{\"n\":1}}\n\nevent: bus-event\ndata: {\"channel\":\"beckon:focus\",\"payload\":{\"n\":2}}\n\n");
        Assert.True(await first);
        Assert.Equal("beckon:sparkle", events.Current.Channel);
        Assert.True(await events.MoveNextAsync());
        Assert.Equal("beckon:focus", events.Current.Channel);
    }

    [Fact]
    public async Task AbandoningOneCallerDoesNotCancelTheirSharedRenewal()
    {
        using var server = new Handler { EmitStatus = token => token == "old" ? HttpStatusCode.Unauthorized : HttpStatusCode.Accepted };
        using var client = new HttpClient(server);
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var renewed = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        CancellationToken refreshToken = default;
        using var transport = new HttpTransport("http://unit.test", "old", ["beckon:focus"], httpClient: client,
            refresher: async (_, cancellation) =>
            {
                Interlocked.Increment(ref calls);
                refreshToken = cancellation;
                started.TrySetResult();
                return await renewed.Task.WaitAsync(cancellation);
            });
        await OpenAsync(transport);
        using var abandoned = new CancellationTokenSource();
        var first = transport.EmitAsync("beckon:focus", JsonSerializer.SerializeToElement(new { }), cancellation: abandoned.Token);
        await started.Task;
        var second = transport.EmitAsync("beckon:focus", JsonSerializer.SerializeToElement(new { }));
        abandoned.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => first);
        Assert.False(refreshToken.IsCancellationRequested);
        renewed.SetResult("new");
        Assert.Null(await second);
        Assert.Equal(1, calls);
    }

    public static IEnumerable<object[]> Refusals()
    {
        using var table = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "specs/errors/codes.json")));
        foreach (var row in table.RootElement.GetProperty("transport").GetProperty("codes").EnumerateArray())
        {
            if (row.TryGetProperty("status", out var exact) || row.TryGetProperty("statusFrom", out exact))
                yield return [exact.GetInt32(), row.GetProperty("code").GetString() ?? throw new InvalidOperationException("Null code")];
        }
    }

    [Theory]
    [MemberData(nameof(Refusals))]
    public async Task EveryHttpRefusalKeepsItsCodeAndStatus(int status, string code)
    {
        using var server = new Handler { Other = (_, _) => Task.FromResult(new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent("{\"error\":\"refused\"}") }) };
        using var client = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", ["beckon:focus"], httpClient: client);
        await OpenAsync(transport);
        await using var errors = transport.Errors().GetAsyncEnumerator();
        var next = errors.MoveNextAsync().AsTask();
        var error = await Assert.ThrowsAsync<TransportError>(() => transport.GetMediaTokenAsync(ResourceId.Parse("r1")));
        Assert.Equal(code, error.Code);
        Assert.Equal(status, error.Status);
        Assert.True(await next);
        Assert.Same(error, errors.Current);
    }

    [Fact]
    public async Task ContentUsesTheGivenClientAndKeepsBinaryBytesAndUploadFields()
    {
        var payload = new byte[] { 0, 1, 127, 128, 255 };
        using var server = new Handler();
        server.Other = async (request, cancellation) =>
        {
            if (request.Method == HttpMethod.Post)
            {
                var form = Assert.IsAssignableFrom<MultipartContent>(request.Content);
                var fields = new Dictionary<string, string>();
                foreach (var part in form)
                {
                    var field = part.Headers.ContentDisposition?.Name?.Trim('"') ?? throw new InvalidOperationException("Unnamed part");
                    if (field == "file") Assert.Equal(payload, await part.ReadAsByteArrayAsync(cancellation));
                    else fields.Add(field, await part.ReadAsStringAsync(cancellation));
                }
                Assert.Equal("A name", fields["name"]);
                Assert.Equal("[\"Person\"]", fields["entityTypes"]);
                return new HttpResponseMessage(HttpStatusCode.Accepted) { Content = new StringContent("{\"resourceId\":\"r-uploaded\"}") };
            }
            var content = new ByteArrayContent(payload);
            content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png");
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
        };
        using var client = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", ["beckon:focus"], httpClient: client);
        await OpenAsync(transport);
        using var content = new HttpContentTransport(transport);
        var uploaded = await content.PutBinaryAsync(new ResourceUpload { Name = "A name", Format = "image/png", StorageUri = "file:///upload", File = payload, EntityTypes = "[\"Person\"]" });
        Assert.Equal("r-uploaded", uploaded.Value);
        var buffered = await content.GetBinaryAsync(uploaded);
        Assert.Equal("image/png", buffered.ContentType);
        Assert.Equal(payload, buffered.Bytes);
        using var streamed = await content.GetBinaryStreamAsync(uploaded);
        using var destination = new MemoryStream();
        await streamed.Stream.CopyToAsync(destination);
        Assert.Equal("image/png", streamed.ContentType);
        Assert.Equal(payload, destination.ToArray());
        content.Dispose();
        content.Dispose();
        Assert.False(streamed.Stream.CanRead);
        Assert.Equal(ConnectionState.Open, transport.State);
    }

    [Fact]
    public async Task ResourceHoldsAreRefcountedAndRemovalWaitsOnThePublicClock()
    {
        var clock = new Clock();
        using var server = new Handler();
        using var client = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", ["beckon:focus"], new Timing { LazyRemoveMs = 50, LingerMs = 0 }, httpClient: client, timeProvider: clock);
        await OpenAsync(transport);
        await server.Subscriptions.Reader.ReadAsync();
        var first = transport.SubscribeToResource(ResourceId.Parse("r1"));
        var second = transport.SubscribeToResource(ResourceId.Parse("r1"));
        await clock.TimerAsync(100);
        clock.Advance(100);
        var added = await server.Subscriptions.Reader.ReadAsync();
        Assert.Equal("r1", added.GetProperty("scoped")[0].GetProperty("scope").GetString());
        first.Dispose();
        first.Dispose();
        second.Dispose();
        await clock.TimerAsync(50);
        clock.Advance(50);
        await clock.TimerAsync(100);
        clock.Advance(100);
        var removed = await server.Subscriptions.Reader.ReadAsync();
        Assert.Equal(0, removed.GetProperty("scoped").GetArrayLength());
    }

    [Fact]
    public async Task ARefusedStreamWaitsForADifferentCredential()
    {
        using var server = new Handler { SubscribeStatus = token => token == "new" ? HttpStatusCode.OK : HttpStatusCode.Unauthorized };
        using var client = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "old", ["beckon:focus"], httpClient: client);
        await using var errors = transport.Errors().GetAsyncEnumerator();
        Assert.True(await errors.MoveNextAsync());
        Assert.Equal("unauthorized", errors.Current.Code);
        Assert.Equal(ConnectionState.Unauthenticated, transport.State);
        transport.SetToken("new");
        await OpenAsync(transport);
        var first = await server.Subscriptions.Reader.ReadAsync();
        var second = await server.Subscriptions.Reader.ReadAsync();
        Assert.Equal(first.GetProperty("clientId").GetString(), second.GetProperty("clientId").GetString());
    }

    [Fact]
    public async Task StreamOpenDeadlineIsNotABodyDeadline()
    {
        var clock = new Clock();
        using var server = new Handler { HoldSubscribe = true };
        using var client = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", ["beckon:focus"], new Timing { StreamOpenMs = 100 }, httpClient: client, timeProvider: clock);
        await clock.TimerAsync(100);
        clock.Advance(100);
        await using var states = transport.States().GetAsyncEnumerator();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (await states.MoveNextAsync().AsTask().WaitAsync(deadline.Token))
        {
            if (states.Current == ConnectionState.Reconnecting) break;
        }
        transport.Dispose();
        await using var errors = transport.Errors().GetAsyncEnumerator();
        Assert.False(await errors.MoveNextAsync());
        await using var final = transport.States().GetAsyncEnumerator();
        Assert.True(await final.MoveNextAsync());
        Assert.Equal(ConnectionState.Closed, final.Current);
        Assert.False(await final.MoveNextAsync());
    }

    [Fact]
    public async Task AStreamEndingReopensWithoutReportingAFailure()
    {
        var clock = new Clock();
        using var server = new Handler();
        using var client = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", ["beckon:focus"], new Timing { ReconnectMs = 50 }, httpClient: client, timeProvider: clock);
        await OpenAsync(transport);
        await server.Subscriptions.Reader.ReadAsync();
        server.Stream.Finish();
        await clock.TimerAsync(50);
        clock.Advance(50);
        await server.Subscriptions.Reader.ReadAsync();
        await OpenAsync(transport);
        transport.Dispose();
        await using var errors = transport.Errors().GetAsyncEnumerator();
        Assert.False(await errors.MoveNextAsync());
    }

    [Fact]
    public async Task PayloadStreamsAndHandlersEndIndependently()
    {
        using var server = new Handler();
        using var client = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", ["beckon:focus"], httpClient: client);
        await OpenAsync(transport);
        await using var errors = transport.Errors().GetAsyncEnumerator();
        var failed = errors.MoveNextAsync().AsTask();
        using var callback = transport.On("beckon:focus", _ => throw new InvalidOperationException("handler failed"));
        await using var payloads = transport.Stream("beckon:focus").GetAsyncEnumerator();
        var delivered = payloads.MoveNextAsync().AsTask();
        server.Stream.Push("event: bus-event\ndata: {\"channel\":\"beckon:focus\",\"payload\":{\"n\":1}}\n\n");
        Assert.True(await delivered);
        Assert.Equal(1, payloads.Current.GetProperty("n").GetInt32());
        Assert.True(await failed);
        Assert.IsType<InvalidOperationException>(errors.Current.InnerException);
        callback.Dispose();
        var ended = payloads.MoveNextAsync().AsTask();
        transport.Dispose();
        Assert.False(await ended);
    }

    [Fact]
    public async Task GatewayAndContentAnswersAreReadThroughTheirSchemas()
    {
        using var server = new Handler();
        server.Other = (request, _) =>
        {
            var body = request.RequestUri?.AbsolutePath switch
            {
                "/api/health" => "{\"status\":\"healthy\",\"message\":\"ready\",\"version\":\"1\",\"timestamp\":\"2026-11-02T00:00:00.000Z\"}",
                "/api/status" => "{\"status\":\"ready\",\"message\":\"ready\",\"version\":\"1\",\"features\":{\"semanticContent\":\"ready\",\"collaboration\":\"ready\"}}",
                "/api/users/me" => "{\"did\":\"did:web:example.org:users:u\",\"email\":null,\"name\":null,\"image\":null,\"domain\":\"example.org\"}",
                "/api/tokens/media" => "{\"token\":\"media-token\"}",
                "/.well-known/oauth-protected-resource" => "{\"resource\":\"http://unit.test\",\"authorization_servers\":[],\"bearer_methods_supported\":[]}",
                "/resources/r1/jsonld" => "{\"resource\":{\"@context\":\"https://schema.org/\",\"@id\":\"r1\",\"name\":\"one\",\"representations\":[]},\"annotations\":[]}",
                "/resources/r1/annotations" => "{\"annotations\":[],\"total\":0}",
                "/resources/r1/anchored-text" => "{\"kind\":\"no-map\"}",
                _ => throw new InvalidOperationException("Unexpected path"),
            };
            if (request.RequestUri?.AbsolutePath == "/.well-known/oauth-protected-resource") Assert.Null(request.Headers.Authorization);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body) });
        };
        using var client = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", ["beckon:focus"], httpClient: client);
        await OpenAsync(transport);
        Assert.Equal("healthy", (await transport.HealthCheckAsync()).Status);
        Assert.Equal("ready", (await transport.GetStatusAsync()).Status);
        Assert.Equal("example.org", (await transport.GetCurrentUserAsync()).Domain);
        Assert.Equal("media-token", (await transport.GetMediaTokenAsync(ResourceId.Parse("r1"))).Token);
        Assert.Equal("http://unit.test", (await transport.GetProtectedResourceMetadataAsync()).Resource);
        using var content = new HttpContentTransport(transport);
        Assert.Equal("one", (await content.GetResourceGraphAsync(ResourceId.Parse("r1"))).Resource.Name);
        Assert.Equal(0, (await content.GetAnnotationsAsync(ResourceId.Parse("r1"))).Total);
        Assert.NotNull(await content.GetAnchoredTextAsync(ResourceId.Parse("r1")));
    }

    [Fact]
    public void RetryBudgetShapeIsHeldToItsOwner()
    {
        var actual = typeof(RetryPolicy).GetProperties().Select(property => char.ToLowerInvariant(property.Name[0]) + property.Name[1..]).Order();
        Assert.Equal(ProtocolFacts.Timing("emitRetry").EnumerateObject().Select(property => property.Name).Order(), actual);
    }

    private static async Task OpenAsync(HttpTransport transport)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await foreach (var state in transport.States(deadline.Token))
        {
            if (state == ConnectionState.Open) return;
        }
        throw new InvalidOperationException("Transport ended before opening");
    }

    private sealed class Handler : HttpMessageHandler
    {
        internal ByteStream Stream { get; private set; } = new();
        internal Channel<JsonElement> Subscriptions { get; } = Channel.CreateUnbounded<JsonElement>();
        internal Func<string?, HttpStatusCode>? SubscribeStatus { get; init; }
        internal bool HoldSubscribe { get; init; }
        private int subscriptions;
        internal Channel<(JsonElement Body, string? Token)> Emits { get; } = Channel.CreateUnbounded<(JsonElement, string?)>();
        internal Action<JsonElement>? Answer { get; set; }
        internal Func<string?, HttpStatusCode>? EmitStatus { get; init; }
        internal Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>>? Other { get; set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.RequestUri?.AbsolutePath == "/bus/subscribe")
            {
                if (Interlocked.Increment(ref subscriptions) > 1) Stream = new();
                using var body = JsonDocument.Parse(await (request.Content ?? throw new InvalidOperationException("No subscription")).ReadAsStringAsync(cancellationToken));
                Subscriptions.Writer.TryWrite(body.RootElement.Clone());
                if (HoldSubscribe) await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                var status = SubscribeStatus?.Invoke(request.Headers.Authorization?.Parameter) ?? HttpStatusCode.OK;
                return new HttpResponseMessage(status) { Content = status == HttpStatusCode.OK ? new StreamContent(Stream) : new StringContent("{}") };
            }
            if (request.RequestUri?.AbsolutePath == "/bus/emit")
            {
                var content = await (request.Content ?? throw new InvalidOperationException("No emit body")).ReadAsStringAsync(cancellationToken);
                using var parsed = JsonDocument.Parse(content);
                var body = parsed.RootElement.Clone();
                Emits.Writer.TryWrite((body, request.Headers.Authorization?.Parameter));
                Answer?.Invoke(body);
                return new HttpResponseMessage(EmitStatus?.Invoke(request.Headers.Authorization?.Parameter) ?? HttpStatusCode.Accepted) { Content = new StringContent("{}") };
            }
            return Other is not null ? await Other(request, cancellationToken) : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{}") };
        }
    }

    private sealed class Clock : TimeProvider
    {
        private readonly FakeTimeProvider fake = new();
        private readonly Channel<TimeSpan> timers = Channel.CreateUnbounded<TimeSpan>();
        public override DateTimeOffset GetUtcNow() => fake.GetUtcNow();
        public override long GetTimestamp() => fake.GetTimestamp();
        public override long TimestampFrequency => fake.TimestampFrequency;
        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            var timer = fake.CreateTimer(callback, state, dueTime, period);
            timers.Writer.TryWrite(dueTime);
            return timer;
        }
        internal void Advance(int ms) => fake.Advance(TimeSpan.FromMilliseconds(ms));
        internal async Task TimerAsync(int ms)
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (await timers.Reader.ReadAsync(deadline.Token) != TimeSpan.FromMilliseconds(ms)) { }
        }
    }

    private sealed class ByteStream : Stream
    {
        private readonly Channel<byte[]> chunks = Channel.CreateUnbounded<byte[]>();
        private byte[] current = [];
        private int offset;
        internal void Push(string text) => chunks.Writer.TryWrite(Encoding.UTF8.GetBytes(text));
        internal void Finish() => chunks.Writer.TryComplete();
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (offset == current.Length)
            {
                if (!await chunks.Reader.WaitToReadAsync(cancellationToken)) return 0;
                current = await chunks.Reader.ReadAsync(cancellationToken);
                offset = 0;
            }
            var count = Math.Min(buffer.Length, current.Length - offset);
            current.AsMemory(offset, count).CopyTo(buffer);
            offset += count;
            return count;
        }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
