using System.Text.Json;
using System.Text.Json.Nodes;
using Semiont.Errors;
using Semiont.Identifiers;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

public sealed partial class TransportTests
{
    [Theory]
    [InlineData("gather", "annotation")]
    [InlineData("gather", "resource")]
    [InlineData("match", "search")]
    public async Task RequestsFollowTheirSurfaceCases(string space, string method)
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(client.Transport);
        var row = SurfaceMethod(space, method);
        var context = SurfaceFixture("context");
        var requestChannel = row.GetProperty("via").GetProperty("request").GetString();

        foreach (var example in row.GetProperty("cases").EnumerateArray())
        {
            var args = JsonNode.Parse(example.GetProperty("args").GetRawText())?.AsObject()
                ?? throw new InvalidOperationException("Missing arguments");
            var resource = ResourceId.Parse(args["resourceId"]?.GetValue<string>() ?? throw new InvalidOperationException("Missing resource"));
            var options = args["options"];
            switch (method)
            {
                case "annotation":
                    var annotation = AnnotationId.Parse(args["annotationId"]?.GetValue<string>() ?? throw new InvalidOperationException("Missing annotation"));
                    server.Answer = sent => Reply(server, sent, BusOperations.GatherRequested.Result.Name,
                        new GatherAnnotationComplete { AnnotationId = annotation, Response = Required<GatheredContext>(context) });
                    var gather = client.Gather.Annotation(resource, annotation, options?.Deserialize<GatherAnnotationOptions>());
                    Assert.False(server.Emits.Reader.TryPeek(out _));
                    await using (var reading = gather.GetAsyncEnumerator(deadline.Token))
                    {
                        Assert.False(server.Emits.Reader.TryPeek(out _));
                        Assert.Throws<InvalidOperationException>(() => gather.GetAsyncEnumerator());
                        await Assert.ThrowsAsync<InvalidOperationException>(() => gather.CompleteAsync(deadline.Token));
                        Assert.True(await reading.MoveNextAsync());
                        Assert.Equal(annotation, reading.Current.AnnotationId);
                        Assert.True(JsonElement.DeepEquals(context, JsonSerializer.SerializeToElement(reading.Current.Response)));
                        Assert.False(await reading.MoveNextAsync());
                    }
                    break;
                case "resource":
                    server.Answer = sent => Reply(server, sent, BusOperations.GatherResourceRequested.Result.Name,
                        new GatherResourceComplete { ResourceId = resource, Response = Required<GatheredContext>(context) });
                    var gathered = options is null
                        ? await client.Gather.ResourceAsync(resource, cancellation: deadline.Token)
                        : options.AsObject().Count == 1
                            ? await client.Gather.ResourceAsync(resource,
                                excludeEntityTypes: options["excludeEntityTypes"]?.Deserialize<string[]>(),
                                cancellation: deadline.Token)
                            : await GatherResourceAsync(client, resource,
                                options.Deserialize<GatherResourceRequestOptions>() ?? throw new InvalidOperationException("Missing gather options"),
                                deadline.Token);
                    Assert.True(JsonElement.DeepEquals(context, JsonSerializer.SerializeToElement(gathered)));
                    break;
                case "search":
                    var reference = AnnotationId.Parse(args["referenceId"]?.GetValue<string>() ?? throw new InvalidOperationException("Missing reference"));
                    var input = ExpandSurfaceFixtures(example.GetProperty("args"));
                    server.Answer = sent => Reply(server, sent, BusOperations.MatchSearchRequested.Result.Name,
                        new MatchSearchResult { ReferenceId = reference, Response = [] });
                    var search = options is null
                        ? client.Match.Search(resource, reference, Required<GatheredContext>(input.GetProperty("context")))
                        : client.Match.Search(resource, reference, Required<GatheredContext>(input.GetProperty("context")),
                            input.GetProperty("options").GetProperty("limit").GetInt64(), input.GetProperty("options").GetProperty("useSemanticScoring").GetBoolean());
                    Assert.False(server.Emits.Reader.TryPeek(out _));
                    var matched = await search;
                    Assert.Equal(reference, matched.ReferenceId);
                    Assert.Empty(matched.Response);
                    Assert.Throws<InvalidOperationException>(() => search.GetAsyncEnumerator());
                    break;
                default: throw new InvalidOperationException("Unknown request method: " + method);
            }
            var (body, _) = await server.Emits.Reader.ReadAsync(deadline.Token);
            Assert.Equal(requestChannel, body.GetProperty("channel").GetString());
            Assert.True(JsonElement.DeepEquals(ExpandSurfaceFixtures(example.GetProperty("sends")), body.GetProperty("payload")));
            Assert.False(server.Emits.Reader.TryPeek(out _));
        }
    }

    [Fact]
    public async Task RequestSearchFollowsItsLocalSurfaceCases()
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var row = SurfaceMethod("match", "requestSearch");

        foreach (var example in row.GetProperty("cases").EnumerateArray())
        {
            var args = ExpandSurfaceFixtures(example.GetProperty("args"));
            await using var frames = client.Bus.Frames(BusChannels.MatchSearchRequested, cancellation: deadline.Token).GetAsyncEnumerator();
            var next = frames.MoveNextAsync().AsTask();
            client.Match.RequestSearch(Required<MatchSearchRequest>(args.GetProperty("input")),
                args.GetProperty("correlationId").GetString() ?? throw new InvalidOperationException("Missing correlation"));
            Assert.True(await next);
            var frame = Assert.IsType<Heard<MatchSearchRequest>.Delivered>(frames.Current).Received.Frame;
            Assert.Equal(row.GetProperty("via").GetProperty("local").GetString(), frame.Channel);
            Assert.Equal(example.GetProperty("correlationId").GetString(), frame.CorrelationId);
            Assert.True(JsonElement.DeepEquals(ExpandSurfaceFixtures(example.GetProperty("sends")), frame.Payload));
            Assert.False(server.Emits.Reader.TryPeek(out _));
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PendingGatherEndsOnCancellationOrClientClose(bool close)
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        using var cancellation = new CancellationTokenSource();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(client.Transport);
        var gather = client.Gather.Annotation(ResourceId.Parse("res-1"), AnnotationId.Parse("ann-1"));
        await using var reading = gather.GetAsyncEnumerator(cancellation.Token);
        var next = reading.MoveNextAsync().AsTask();
        await server.Emits.Reader.ReadAsync(deadline.Token);
        if (close)
        {
            client.Dispose();
            var error = await Assert.ThrowsAsync<BusRequestError>(() => next.WaitAsync(deadline.Token));
            Assert.Equal("bus.closed", error.Code);
        }
        else
        {
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => next.WaitAsync(deadline.Token));
        }
    }

    private static Task<GatheredContext> GatherResourceAsync(SemiontClient client, ResourceId resource,
        GatherResourceRequestOptions options, CancellationToken cancellation) =>
        client.Gather.ResourceAsync(resource, options.Depth, options.MaxResources, options.IncludeContent,
            options.IncludeSummary, options.ExcludeEntityTypes, cancellation);

    private static T Required<T>(JsonElement payload) where T : class =>
        payload.Deserialize<T>() ?? throw new InvalidOperationException("Missing " + typeof(T).Name);

    private static JsonElement SurfaceFixture(string name)
    {
        using var table = JsonDocument.Parse(File.ReadAllText(Path.Join(AppContext.BaseDirectory, "specs/client/surface.json")));
        return table.RootElement.GetProperty("fixtures").GetProperty(name).Clone();
    }

    private static JsonElement ExpandSurfaceFixtures(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            if (value.TryGetProperty("$fixture", out var name))
                return SurfaceFixture(name.GetString() ?? throw new InvalidOperationException("Missing fixture name"));
            return JsonSerializer.SerializeToElement(value.EnumerateObject().ToDictionary(
                property => property.Name, property => ExpandSurfaceFixtures(property.Value)));
        }
        if (value.ValueKind == JsonValueKind.Array)
            return JsonSerializer.SerializeToElement(value.EnumerateArray().Select(ExpandSurfaceFixtures));
        return value;
    }

    private static void Reply<T>(Handler server, JsonElement sent, string channel, T payload)
    {
        var frame = JsonSerializer.Serialize(new { channel, correlationId = sent.GetProperty("correlationId"), payload });
        server.Stream.Push("event: bus-event\ndata: " + frame + "\n\n");
    }
}
