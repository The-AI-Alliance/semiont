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

public sealed partial class TransportTests
{
    [Theory]
    [InlineData("bind", "initiate")]
    [InlineData("bind", "reportBodyError")]
    [InlineData("beckon", "hover")]
    [InlineData("beckon", "sparkle")]
    public async Task LocalSignalsFollowTheirSurfaceCases(string space, string method)
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        var row = SurfaceMethod(space, method);
        var expected = row.GetProperty("via").GetProperty("local").GetString();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));

        async Task VerifyAsync<T>(BusChannel<T> channel, Action signal, JsonElement example) where T : class
        {
            await using var frames = client.Bus.Frames(channel, cancellation: deadline.Token).GetAsyncEnumerator();
            var next = frames.MoveNextAsync().AsTask();
            signal();
            Assert.True(await next);
            var frame = Assert.IsType<Heard<T>.Delivered>(frames.Current);
            Assert.Equal(expected, frame.Received.Frame.Channel);
            Assert.True(JsonElement.DeepEquals(example.GetProperty("sends"), frame.Received.Frame.Payload));
            Assert.False(server.Emits.Reader.TryPeek(out _));
        }

        foreach (var example in row.GetProperty("cases").EnumerateArray())
        {
            var args = example.GetProperty("args");
            switch (method)
            {
                case "initiate":
                    var binding = args.GetProperty("input").Deserialize<BindInitiateCommand>() ?? throw new InvalidOperationException("No binding");
                    await VerifyAsync(BusChannels.BindInitiate, () => client.Bind.Initiate(binding), example);
                    break;
                case "reportBodyError":
                    var error = args.GetProperty("input").Deserialize<ResourceErrorEvent>() ?? throw new InvalidOperationException("No error");
                    await VerifyAsync(BusChannels.BindBodyError, () => client.Bind.ReportBodyError(error), example);
                    break;
                case "hover":
                    await VerifyAsync(BusChannels.BeckonHover, () => client.Beckon.Hover(args.GetProperty("annotationId").Deserialize<AnnotationId?>()), example);
                    break;
                case "sparkle":
                    await VerifyAsync(BusChannels.BeckonSparkle, () => client.Beckon.Sparkle(args.GetProperty("annotationId").Deserialize<AnnotationId>()), example);
                    break;
                default: throw new InvalidOperationException("Unknown local method: " + method);
            }
        }
    }

    [Theory]
    [InlineData("attention", 0)]
    [InlineData("click", null)]
    [InlineData("openResource", 2)]
    [InlineData("sparkleAll", 1)]
    public async Task BeckonWireSignalsFollowTheirSurfaceCases(string method, int? count)
    {
        using var server = new Handler { EmitReply = JsonSerializer.Serialize(new BusEmitAccepted { Subscribers = count }) };
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        var row = SurfaceMethod("beckon", method);
        var expected = row.GetProperty("via").GetProperty("emit").GetString();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        foreach (var example in row.GetProperty("cases").EnumerateArray())
        {
            var args = example.GetProperty("args");
            var result = method switch
            {
                "attention" => await client.Beckon.AttentionAsync(args.GetProperty("resourceId").Deserialize<ResourceId>(),
                    args.TryGetProperty("annotationId", out var id) ? id.Deserialize<AnnotationId?>() : null, deadline.Token),
                "click" => await client.Beckon.ClickAsync(args.GetProperty("annotationId").Deserialize<AnnotationId>(), deadline.Token),
                "openResource" => await client.Beckon.OpenResourceAsync(args.GetProperty("resourceId").Deserialize<ResourceId>(), deadline.Token),
                "sparkleAll" => await client.Beckon.SparkleAllAsync(args.GetProperty("annotationId").Deserialize<AnnotationId>(), deadline.Token),
                _ => throw new InvalidOperationException("Unknown wire method: " + method),
            };
            var sent = await server.Emits.Reader.ReadAsync(deadline.Token);
            Assert.Equal(expected, sent.Body.GetProperty("channel").GetString());
            Assert.True(JsonElement.DeepEquals(example.GetProperty("sends"), sent.Body.GetProperty("payload")));
            Assert.Equal(count, result);
        }
    }

    [Fact]
    public async Task BindingBodyAwaitsTheSharedOperationReply()
    {
        var row = SurfaceMethod("bind", "body");
        var example = Assert.Single(row.GetProperty("cases").EnumerateArray());
        var args = example.GetProperty("args");
        var expected = row.GetProperty("via").GetProperty("request").GetString();
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var pending = client.Bind.BodyAsync(args.GetProperty("resourceId").Deserialize<ResourceId>(),
            args.GetProperty("annotationId").Deserialize<AnnotationId>(),
            args.GetProperty("operations").Deserialize<BindBodyOperation[]>() ?? throw new InvalidOperationException("No operations"),
            deadline.Token);
        var sent = await server.Emits.Reader.ReadAsync(deadline.Token);
        Assert.False(pending.IsCompleted);
        Assert.Equal(expected, sent.Body.GetProperty("channel").GetString());
        Assert.True(JsonElement.DeepEquals(example.GetProperty("sends"), sent.Body.GetProperty("payload")));
        var frame = JsonSerializer.Serialize(new
        {
            channel = BusOperations.BindUpdateBody.Result.Name,
            correlationId = sent.Body.GetProperty("correlationId").GetString(),
            payload = new { },
        });
        server.Stream.Push("event: bus-event\ndata: " + frame + "\n\n");
        await pending.WaitAsync(deadline.Token);
    }

    [Fact]
    public async Task LocalBusBridgesWireFramesAndKeepsLocalSignalsOffTheWire()
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        await OpenAsync(client.Transport);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var local = client.Bus.Frames(BusChannels.BeckonSparkle, cancellation: deadline.Token).GetAsyncEnumerator();
        await using var wire = client.Wire.Frames(BusChannels.BeckonSparkle, cancellation: deadline.Token).GetAsyncEnumerator();
        var localFirst = local.MoveNextAsync().AsTask();
        var wireFirst = wire.MoveNextAsync().AsTask();
        client.Beckon.Sparkle(AnnotationId.Parse("ann-local"));
        Assert.True(await localFirst);
        Assert.Equal("ann-local", Assert.IsType<Heard<BeckonSparkleEvent>.Delivered>(local.Current).Payload.AnnotationId.Value);
        Assert.False(wireFirst.IsCompleted);
        Assert.False(server.Emits.Reader.TryPeek(out _));

        var localNext = local.MoveNextAsync().AsTask();
        server.Stream.Push("event: bus-event\ndata: " + """
            {"channel":"beckon:sparkle","payload":{"annotationId":"ann-wire","_userId":"did:web:example.org:users:ada"}}
            """ + "\n\n");
        Assert.True(await wireFirst);
        Assert.True(await localNext);
        Assert.True(JsonElement.DeepEquals(wire.Current.Received.Frame.Payload, local.Current.Received.Frame.Payload));
        Assert.Equal("did:web:example.org:users:ada", local.Current.Received.UserId?.Value);
        client.Dispose();
        Assert.False(await local.MoveNextAsync());
    }

    [Fact]
    public async Task TypedFramesKeepAttributionAndRefuseMalformedPayloadsInPlace()
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        await OpenAsync(client.Transport);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var frames = client.Wire.Frames(BusChannels.BeckonFocus, cancellation: deadline.Token).GetAsyncEnumerator();
        var first = frames.MoveNextAsync().AsTask();
        server.Stream.Push("event: bus-event\ndata: {\"channel\":\"beckon:focus\",\"payload\":{}}\n\n");
        server.Stream.Push("event: bus-event\ndata: " + """
            {"channel":"beckon:focus","payload":{"resourceId":"r1","_userId":"did:web:example.org:users:ada","_trace":{"traceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"}}}
            """ + "\n\n");

        Assert.True(await first);
        Assert.IsType<Heard<BeckonFocusEvent>.Refused>(frames.Current);
        Assert.True(await frames.MoveNextAsync());
        var delivered = Assert.IsType<Heard<BeckonFocusEvent>.Delivered>(frames.Current);
        Assert.Equal("r1", delivered.Payload.ResourceId.Value);
        Assert.Equal("did:web:example.org:users:ada", delivered.Received.UserId?.Value);
        Assert.Equal("4bf92f3577b34da6a3ce929d0e0e4736", delivered.Received.Trace.TraceId.ToString());
        Assert.False(delivered.Received.Frame.Payload.TryGetProperty("_trace", out _));
    }

    [Fact]
    public async Task TypedScopedFramesHoldAndReleaseTheResourceAndFilterOtherScopes()
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", ["beckon:focus"],
            new Timing { LazyRemoveMs = 0, LingerMs = 0 }, httpClient: http);
        var bus = new Bus(transport);
        await OpenAsync(transport);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await server.Subscriptions.Reader.ReadAsync(deadline.Token);
        await using (var frames = bus.Frames(BusChannels.MarkBodyUpdated, ResourceId.Parse("r1"), deadline.Token).GetAsyncEnumerator())
        {
            var first = frames.MoveNextAsync().AsTask();
            var subscription = await server.Subscriptions.Reader.ReadAsync(deadline.Token);
            Assert.Equal("r1", Assert.Single(subscription.GetProperty("scoped").EnumerateArray()).GetProperty("scope").GetString());
            server.Stream.Push("event: bus-event\ndata: {\"channel\":\"mark:body-updated\",\"scope\":\"r2\",\"payload\":{}}\n\n");
            server.Stream.Push("event: bus-event\ndata: {\"channel\":\"mark:body-updated\",\"scope\":\"r1\",\"payload\":{}}\n\n");
            Assert.True(await first);
            Assert.Equal("r1", frames.Current.Received.Frame.Scope?.Value);
        }
        var released = await server.Subscriptions.Reader.ReadAsync(deadline.Token);
        Assert.Empty(released.GetProperty("scoped").EnumerateArray());
    }

    [Fact]
    public async Task TypedEmitUsesTheGeneratedChannelAndPayload()
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        await OpenAsync(client.Transport);
        await client.Wire.EmitAsync(BusChannels.BeckonFocus, new BeckonFocusEvent { ResourceId = ResourceId.Parse("r1") },
            correlationId: "typed-emit");
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var sent = await server.Emits.Reader.ReadAsync(deadline.Token);
        Assert.Equal("token", sent.Token);
        Assert.Equal("beckon:focus", sent.Body.GetProperty("channel").GetString());
        Assert.Equal("typed-emit", sent.Body.GetProperty("correlationId").GetString());
        Assert.Equal("r1", sent.Body.GetProperty("payload").GetProperty("resourceId").GetString());
    }

    [Fact]
    public async Task TypedOperationsDecodeTheDeclaredReplyEnvelope()
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        await OpenAsync(client.Transport);
        server.Answer = sent =>
        {
            var frame = JsonSerializer.Serialize(new
            {
                channel = BusOperations.YieldCloneTokenRequested.Result.Name,
                correlationId = sent.GetProperty("correlationId").GetString(),
                payload = JsonSerializer.Deserialize<JsonElement>("""
                    {"response":{"token":"clone","expiresAt":"2026-11-04T00:00:00Z","resource":{"@context":"https://schema.org","@id":"r1","name":"One","representations":[]}}}
                    """),
            });
            server.Stream.Push("event: bus-event\ndata: " + frame + "\n\n");
        };
        var result = await client.Wire.RequestAsync(BusOperations.YieldCloneTokenRequested,
            new YieldCloneTokenRequest { ResourceId = ResourceId.Parse("r1") });
        Assert.Equal("clone", result.Response.Token);
    }

    [Theory]
    [InlineData("addEntityType")]
    [InlineData("addEntityTypes")]
    [InlineData("addTagSchema")]
    public async Task ClientFrameMethodsFollowTheirSurfaceCases(string method)
    {
        var row = SurfaceMethod("frame", method);
        var example = Assert.Single(row.GetProperty("cases").EnumerateArray());
        var args = example.GetProperty("args");
        var channel = row.GetProperty("via").GetProperty("request").GetString() ?? throw new InvalidOperationException("Missing request channel");

        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "credential", http);
        await OpenAsync(client.Transport);

        var call = method switch
        {
            "addEntityType" => client.Frame.AddEntityTypeAsync(args.GetProperty("type").Deserialize<string>() ?? throw new InvalidOperationException("Missing type")),
            "addEntityTypes" => client.Frame.AddEntityTypesAsync(args.GetProperty("types").Deserialize<string[]>() ?? throw new InvalidOperationException("Missing types")),
            "addTagSchema" => client.Frame.AddTagSchemaAsync(args.GetProperty("schema").Deserialize<TagSchema>() ?? throw new InvalidOperationException("Missing schema")),
            _ => throw new InvalidOperationException("Unknown frame method: " + method),
        };
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));

        async Task ObserveAndAnswerAsync(string expectedChannel, JsonElement expectedPayload)
        {
            var sent = await server.Emits.Reader.ReadAsync(deadline.Token);
            Assert.Equal("credential", sent.Token);
            Assert.Equal(expectedChannel, sent.Body.GetProperty("channel").GetString());
            Assert.True(JsonElement.DeepEquals(expectedPayload, sent.Body.GetProperty("payload")));
            Assert.False(call.IsCompleted);
            Assert.False(server.Emits.Reader.TryPeek(out _));
            var result = ProtocolFacts.Operation(expectedChannel).Result;
            var frame = JsonSerializer.Serialize(new
            {
                channel = result,
                correlationId = sent.Body.GetProperty("correlationId").GetString(),
                payload = new { },
            });
            server.Stream.Push("event: bus-event\ndata: " + frame + "\n\n");
        }

        await ObserveAndAnswerAsync(channel, example.GetProperty("sends"));
        if (example.TryGetProperty("then", out var then))
            foreach (var next in then.EnumerateArray())
                await ObserveAndAnswerAsync(next.GetProperty("request").GetString() ?? throw new InvalidOperationException("Missing follow-up channel"), next.GetProperty("sends"));

        await call.WaitAsync(deadline.Token);
        Assert.False(server.Emits.Reader.TryPeek(out _));
        client.Dispose();
        Assert.Equal(ConnectionState.Closed, client.State);
        using var response = await http.GetAsync("http://unit.test/caller-owned");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Theory]
    [InlineData("auth", "me", "current-user", """{"did":"did:web:kb.example:users:ada","domain":"kb.example","email":null,"name":null,"image":null}""")]
    [InlineData("auth", "mediaToken", "media-token", """{"token":"media"}""")]
    [InlineData("auth", "protectedResourceMetadata", "protected-resource-metadata", """{"resource":"https://kb.example","authorization_servers":["https://issuer.example"],"bearer_methods_supported":["header"]}""")]
    [InlineData("system", "healthCheck", "health", """{"status":"healthy","message":"up","version":"1","timestamp":"2026-11-03T00:00:00Z"}""")]
    [InlineData("system", "status", "status", """{"status":"ready","version":"1","features":{"semanticContent":"up","collaboration":"up"},"message":"ready"}""")]
    public async Task ClientGatewayMethodsFollowTheirSurfaceCases(string space, string method, string driver, string reply)
    {
        var row = SurfaceMethod(space, method);
        var example = Assert.Single(row.GetProperty("cases").EnumerateArray());
        using var corpus = JsonDocument.Parse(File.ReadAllText(Path.Join(AppContext.BaseDirectory, "corpus/sdk/wire/gateway-operations.json")));
        var steps = corpus.RootElement.GetProperty("steps").EnumerateArray().ToArray();
        var at = Array.FindIndex(steps, step => step.TryGetProperty("driver", out var name) && name.GetString() == driver);
        Assert.True(at >= 0);
        var wire = steps[at + 1];
        var requests = 0;
        using var server = new Handler
        {
            Other = async (request, cancellation) =>
            {
                requests++;
                Assert.Equal(wire.GetProperty("wire").GetString(), request.Method.Method + " " + request.RequestUri?.AbsolutePath);
                if (wire.TryGetProperty("token", out _)) Assert.Equal("credential", request.Headers.Authorization?.Parameter);
                if (method == "protectedResourceMetadata") Assert.Null(request.Headers.Authorization);
                using var body = JsonDocument.Parse(request.Content is null ? "{}" : await request.Content.ReadAsStringAsync(cancellation));
                Assert.True(JsonElement.DeepEquals(example.GetProperty("sends"), body.RootElement));
                return new HttpResponseMessage((HttpStatusCode)wire.GetProperty("status").GetInt32()) { Content = new StringContent(reply) };
            },
        };
        using var http = new HttpClient(server);
        using var client = new SemiontClient(new HttpTransport("http://unit.test", "credential", [], httpClient: http));
        var actual = method switch
        {
            "me" => JsonSerializer.SerializeToElement(await client.Auth.MeAsync()),
            "mediaToken" => JsonSerializer.SerializeToElement(await client.Auth.MediaTokenAsync(
                example.GetProperty("args").GetProperty("resourceId").Deserialize<ResourceId>())),
            "protectedResourceMetadata" => JsonSerializer.SerializeToElement(await client.Auth.ProtectedResourceMetadataAsync()),
            "healthCheck" => JsonSerializer.SerializeToElement(await client.System.HealthCheckAsync()),
            "status" => JsonSerializer.SerializeToElement(await client.System.StatusAsync()),
            _ => throw new InvalidOperationException("Unknown gateway method: " + method),
        };
        using var expected = JsonDocument.Parse(reply);
        Assert.True(JsonElement.DeepEquals(expected.RootElement, actual));
        Assert.Equal(1, requests);
    }

    private static JsonElement SurfaceMethod(string space, string method)
    {
        using var table = JsonDocument.Parse(File.ReadAllText(Path.Join(AppContext.BaseDirectory, "specs/client/surface.json")));
        return table.RootElement.GetProperty("namespaces").EnumerateArray()
            .Single(row => row.GetProperty("namespace").GetString() == space).GetProperty("methods").EnumerateArray()
            .Single(row => row.GetProperty("method").GetString() == method).Clone();
    }

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
        var clock = new TestClock();
        using var server = new Handler();
        using var client = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", ["browse:resource-result", "browse:resource-failed"], httpClient: client, timeProvider: clock);
        await OpenAsync(transport);
        var waiting = transport.RequestAsync("browse:resource-requested", JsonSerializer.SerializeToElement(new { resourceId = "r1" }), 1000);
        await server.Emits.Reader.ReadAsync();
        Assert.False(waiting.IsCompleted);
        await clock.WaitForAsync(TimeSpan.FromMilliseconds(1000));
        clock.Advance(TimeSpan.FromMilliseconds(1000));
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
        var clock = new TestClock();
        using var server = new Handler();
        using var client = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", ["beckon:focus"], new Timing { LazyRemoveMs = 50, LingerMs = 0 }, httpClient: client, timeProvider: clock);
        await OpenAsync(transport);
        await server.Subscriptions.Reader.ReadAsync();
        var first = transport.SubscribeToResource(ResourceId.Parse("r1"));
        var second = transport.SubscribeToResource(ResourceId.Parse("r1"));
        await clock.WaitForAsync(TimeSpan.FromMilliseconds(100));
        clock.Advance(TimeSpan.FromMilliseconds(100));
        var added = await server.Subscriptions.Reader.ReadAsync();
        Assert.Equal("r1", added.GetProperty("scoped")[0].GetProperty("scope").GetString());
        first.Dispose();
        first.Dispose();
        second.Dispose();
        await clock.WaitForAsync(TimeSpan.FromMilliseconds(50));
        clock.Advance(TimeSpan.FromMilliseconds(50));
        await clock.WaitForAsync(TimeSpan.FromMilliseconds(100));
        clock.Advance(TimeSpan.FromMilliseconds(100));
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
        var clock = new TestClock();
        using var server = new Handler { HoldSubscribe = true };
        using var client = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", ["beckon:focus"], new Timing { StreamOpenMs = 100 }, httpClient: client, timeProvider: clock);
        await clock.WaitForAsync(TimeSpan.FromMilliseconds(100));
        clock.Advance(TimeSpan.FromMilliseconds(100));
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
        var clock = new TestClock();
        using var server = new Handler();
        using var client = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", ["beckon:focus"], new Timing { ReconnectMs = 50 }, httpClient: client, timeProvider: clock);
        await OpenAsync(transport);
        await server.Subscriptions.Reader.ReadAsync();
        server.Stream.Finish();
        await clock.WaitForAsync(TimeSpan.FromMilliseconds(50));
        clock.Advance(TimeSpan.FromMilliseconds(50));
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
        internal string EmitReply { get; init; } = "{}";
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
                return new HttpResponseMessage(EmitStatus?.Invoke(request.Headers.Authorization?.Parameter) ?? HttpStatusCode.Accepted) { Content = new StringContent(EmitReply) };
            }
            return Other is not null ? await Other(request, cancellationToken) : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{}") };
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
