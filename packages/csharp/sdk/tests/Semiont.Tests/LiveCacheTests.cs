using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading.Channels;
using Semiont.Errors;
using Semiont.Identifiers;
using Semiont.Http;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

public sealed partial class TransportTests
{
    [Theory]
    [InlineData("browse", "resource")]
    [InlineData("browse", "resources")]
    [InlineData("browse", "annotations")]
    [InlineData("browse", "annotation")]
    [InlineData("browse", "entityTypes")]
    [InlineData("browse", "tagSchemas")]
    [InlineData("browse", "engines")]
    [InlineData("browse", "events")]
    [InlineData("gather", "referencedBy")]
    [InlineData("match", "resources")]
    public async Task LiveQueriesFollowTheirSurfaceCases(string space, string method)
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(client.Transport);
        var row = SurfaceMethod(space, method);
        var resource = ResourceId.Parse("res-1");
        var annotation = Required<Annotation>(ReadAnnotationExample());

        async Task<T> VerifyAsync<T, TReply>(Func<Cached<T>> query, string replyChannel, TReply reply, JsonElement example)
        {
            var expectedRequest = Text(row.GetProperty("via"), "request");
            server.Answer = sent =>
            {
                var request = Text(sent, "channel");
                if (request == expectedRequest)
                {
                    Reply(server, sent, replyChannel, reply);
                    return;
                }

                var operation = BusOperations.Limits.Single(operation => operation.Request.Name == request);
                Reply(server, sent, operation.Result.Name, JsonSerializer.Deserialize<JsonElement>("""
                    {"response":{"limits":[{"engine":{"provider":"ollama","model":"sample"},"limits":{"contextTokens":100,"maxOutputTokens":50}}]}}
                    """));
            };
            var cached = query();
            Assert.Same(cached, query());
            Assert.False(server.Emits.Reader.TryPeek(out _));
            var value = await cached.FreshAsync(deadline.Token);
            await ExpectRequestAsync(server, row, example, deadline.Token);
            return value;
        }

        foreach (var example in row.GetProperty("cases").EnumerateArray())
        {
            var args = example.GetProperty("args");
            switch (space, method)
            {
                case ("browse", "resource"):
                    var descriptor = await VerifyAsync(() => client.Browse.Resource(args.GetProperty("resourceId").Deserialize<ResourceId>()),
                        BusOperations.BrowseResourceRequested.Result.Name, new { response = new { resource = SourceResource(), lastSequence = 1 } }, example);
                    Assert.Equal(resource, descriptor.Id);
                    break;
                case ("browse", "resources"):
                    var listed = await VerifyAsync(() => args.TryGetProperty("filters", out var filters)
                            ? client.Browse.Resources(Limit(filters), Offset(filters), Archived(filters), EntityType(filters))
                            : client.Browse.Resources(),
                        BusOperations.BrowseResourcesRequested.Result.Name, new { response = new ListResourcesResponse { Resources = [], Total = 0, Limit = 100, Offset = 0 } }, example);
                    Assert.Empty(listed.Resources);
                    break;
                case ("browse", "annotations"):
                    var httpReads = 0;
                    server.Other = (request, _) =>
                    {
                        Assert.Equal("/resources/" + Text(example.GetProperty("sends"), "resourceId") + "/annotations", request.RequestUri?.AbsolutePath);
                        httpReads++;
                        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                        {
                            Content = JsonContent.Create(new GetAnnotationsResponse { Total = 1, Annotations = [annotation] }),
                        });
                    };
                    var query = client.Browse.Annotations(args.GetProperty("resourceId").Deserialize<ResourceId>());
                    Assert.Equal(0, httpReads);
                    Assert.Equal(annotation.Id, Assert.Single(await query.FreshAsync(deadline.Token)).Id);
                    Assert.Equal(1, httpReads);
                    break;
                case ("browse", "annotation"):
                    var one = await VerifyAsync(() => client.Browse.Annotation(args.GetProperty("resourceId").Deserialize<ResourceId>(),
                            args.GetProperty("annotationId").Deserialize<AnnotationId>()),
                        BusOperations.BrowseAnnotationRequested.Result.Name, new { response = new GetAnnotationResponse { Annotation = annotation, Resource = null, ResolvedResource = null } }, example);
                    Assert.Equal(annotation.Id, one.Id);
                    break;
                case ("browse", "entityTypes"):
                    Assert.Equal(["Person"], await VerifyAsync(client.Browse.EntityTypes, BusOperations.BrowseEntityTypesRequested.Result.Name,
                        new { response = new { entityTypes = new[] { "Person" } } }, example));
                    break;
                case ("browse", "tagSchemas"):
                    Assert.Empty(await VerifyAsync(client.Browse.TagSchemas, BusOperations.BrowseTagSchemasRequested.Result.Name,
                        new { response = new { tagSchemas = Array.Empty<TagSchema>() } }, example));
                    break;
                case ("browse", "engines"):
                    var engines = await VerifyAsync(client.Browse.Engines, BusOperations.BrowseEnginesRequested.Result.Name,
                        JsonSerializer.Deserialize<JsonElement>("""{"response":{"engines":[{"engine":{"provider":"ollama","model":"sample"}}]}}"""), example);
                    Assert.Equal(100, Assert.Single(engines).Limits?.ContextTokens);
                    var seen = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var _ in BusOperations.Limits)
                        seen.Add(Text((await server.Emits.Reader.ReadAsync(deadline.Token)).Body, "channel"));
                    Assert.True(seen.SetEquals(BusOperations.Limits.Select(operation => operation.Request.Name)));
                    break;
                case ("browse", "events"):
                    Assert.Empty(await VerifyAsync(() => client.Browse.Events(args.GetProperty("resourceId").Deserialize<ResourceId>()),
                        BusOperations.BrowseEventsRequested.Result.Name, new { response = new GetEventsResponse { Events = [], ResourceId = resource, Total = 0 } }, example));
                    break;
                case ("gather", "referencedBy"):
                    Assert.Empty(await VerifyAsync(() => client.Gather.ReferencedBy(args.GetProperty("resourceId").Deserialize<ResourceId>()),
                        BusOperations.GatherReferencedByRequested.Result.Name,
                        new { response = new { referencedBy = Array.Empty<GetReferencedByResponseReferencedByItem>() } }, example));
                    break;
                case ("match", "resources"):
                    var matched = await VerifyAsync(() => args.TryGetProperty("filters", out var filters)
                            ? client.Match.Resources(Text(args, "search"), Limit(filters), Offset(filters), Archived(filters), EntityType(filters))
                            : client.Match.Resources(Text(args, "search")),
                        BusOperations.MatchResourcesRequested.Result.Name, new { response = new MatchResourcesResponse { Resources = [], Total = 0, Limit = 100, Offset = 0, MatchKind = MatchResourcesResponseMatchKind.Lexical } }, example);
                    Assert.Empty(matched.Resources);
                    break;
                default: throw new InvalidOperationException("Unknown live query " + method);
            }
            Assert.False(server.Emits.Reader.TryPeek(out _));
        }

        static long Limit(JsonElement filters) => filters.TryGetProperty("limit", out var limit) ? limit.GetInt64() : 100;
        static long Offset(JsonElement filters) => filters.TryGetProperty("offset", out var offset) ? offset.GetInt64() : 0;
        static bool? Archived(JsonElement filters) => filters.TryGetProperty("archived", out var archived) ? archived.GetBoolean() : null;
        static string? EntityType(JsonElement filters) => filters.TryGetProperty("entityType", out var entity) ? entity.GetString() : null;

        static JsonElement ReadAnnotationExample()
        {
            using var reader = ReadSpec("annotations/reader-cases.json");
            return reader.RootElement.GetProperty("cases")[0].GetProperty("annotation").Clone();
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PersistenceAdvancesBookmarksWithSettledValues(bool settles)
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", [], httpClient: http);
        var clock = new TestClock();
        string? document = null;
        using var storage = new LiveCacheStorage(new CachePersistence(() => null, saved => document = saved), clock);
        var answer = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cache = new Cache<ResourceId, int>((_, cancellation) => answer.Task.WaitAsync(cancellation), null,
            clock, TimeSpan.Zero, storage.Changed);
        storage.Start(transport, [cache.PersistAs("resource")]);

        var resource = ResourceId.Parse("res-1");
        cache.Set(resource, 1);
        var frame = new ReceivedBusFrame(new BusFrame
        {
            Channel = BusChannels.MarkAdded.Name,
            Scope = resource,
            Payload = JsonSerializer.SerializeToElement(new { }),
        }, default)
        { EventId = "p-1" };
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        Task<int>? refresh = null;
        storage.Apply(frame, () => refresh = cache.FetchAsync(resource, deadline.Token));
        if (settles)
        {
            answer.SetResult(2);
            Assert.Equal(2, await Assert.IsAssignableFrom<Task<int>>(refresh));
        }
        storage.Dispose();

        using var saved = JsonDocument.Parse(Assert.IsType<string>(document));
        Assert.Equal(settles ? 2 : 1, saved.RootElement.GetProperty("Values")[0].GetProperty("Value").GetInt32());
        var bookmarks = saved.RootElement.GetProperty("Bookmarks");
        Assert.Equal(settles, bookmarks.TryGetProperty(resource.Value, out var bookmark));
        if (settles) Assert.Equal("p-1", bookmark.GetString());
    }

    [Theory]
    [InlineData("""{"Version":99,"Values":[],"Bookmarks":{}}""")]
    [InlineData("""{"Version":1,"Values":[{"Cache":"resource"}],"Bookmarks":{}}""")]
    [InlineData("invalid JSON")]
    public async Task InvalidPersistenceStartsEmpty(string document)
    {
        using var server = new Handler();
        using var http = new HttpClient(server);
        using var transport = new HttpTransport("http://unit.test", "token", [], httpClient: http);
        using var storage = new LiveCacheStorage(new CachePersistence(() => document, _ => { }), TimeProvider.System);
        using var cache = new Cache<ResourceId, int>((_, _) => Task.FromResult(7));
        storage.Start(transport, [cache.PersistAs("resource")]);

        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var observer = cache.Observe(ResourceId.Parse("res-1")).GetAsyncEnumerator(deadline.Token);
        Assert.True(await observer.MoveNextAsync());
        Assert.IsType<CacheState<int>.Pending>(observer.Current);
        Assert.True(await observer.MoveNextAsync());
        Assert.Equal(7, Assert.IsType<CacheState<int>.Ready>(observer.Current).Value);
    }

    [Fact]
    public async Task FirstObserversShareAFetchAndRecoveryReachesExistingReaders()
    {
        var loads = Channel.CreateUnbounded<TaskCompletionSource<int>>();
        using var cache = new Cache<string, int>((_, cancellation) =>
        {
            var answer = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
            loads.Writer.TryWrite(answer);
            return answer.Task.WaitAsync(cancellation);
        });
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var key = cache.Observe("key");
        Assert.Same(key, cache.Observe("key"));
        Assert.False(loads.Reader.TryPeek(out _));
        await using var first = key.GetAsyncEnumerator(deadline.Token);
        await using var second = key.GetAsyncEnumerator(deadline.Token);
        Assert.True(await first.MoveNextAsync());
        Assert.True(await second.MoveNextAsync());
        Assert.IsType<CacheState<int>.Pending>(first.Current);
        Assert.IsType<CacheState<int>.Pending>(second.Current);

        var initial = await loads.Reader.ReadAsync(deadline.Token);
        Assert.False(loads.Reader.TryPeek(out _));
        initial.SetException(new InvalidOperationException("first"));
        var retry = await loads.Reader.ReadAsync(deadline.Token);
        retry.SetException(new InvalidOperationException("retry"));
        Assert.True(await first.MoveNextAsync());
        Assert.True(await second.MoveNextAsync());
        Assert.Equal("retry", Assert.IsType<CacheState<int>.Failed>(first.Current).Error.Message);
        Assert.Same(first.Current, second.Current);
        Assert.False(loads.Reader.TryPeek(out _));

        await using var recovery = key.GetAsyncEnumerator(deadline.Token);
        Assert.True(await recovery.MoveNextAsync());
        Assert.IsType<CacheState<int>.Pending>(recovery.Current);
        Assert.True(await first.MoveNextAsync());
        Assert.IsType<CacheState<int>.Pending>(first.Current);
        (await loads.Reader.ReadAsync(deadline.Token)).SetResult(7);
        Assert.True(await recovery.MoveNextAsync());
        Assert.True(await first.MoveNextAsync());
        Assert.Equal(7, Assert.IsType<CacheState<int>.Ready>(first.Current).Value);
        Assert.Same(first.Current, recovery.Current);
        cache.Dispose();
        Assert.False(await second.MoveNextAsync());
        var closed = await Assert.ThrowsAsync<BusRequestError>(() => key.FreshAsync(deadline.Token));
        Assert.Equal("bus.closed", closed.Code);
    }

    [Fact]
    public async Task InvalidationBypassesPendingWorkAndFreshReadsShareOnlyTheCurrentLoad()
    {
        var loads = Channel.CreateUnbounded<TaskCompletionSource<int>>();
        using var cache = new Cache<string, int>((_, cancellation) =>
        {
            var answer = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
            loads.Writer.TryWrite(answer);
            return answer.Task.WaitAsync(cancellation);
        });
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var key = cache.Observe("key");
        var orphaned = key.FreshAsync(deadline.Token);
        var older = await loads.Reader.ReadAsync(deadline.Token);
        key.Invalidate();
        var newer = await loads.Reader.ReadAsync(deadline.Token);
        var joined = key.FreshAsync(deadline.Token);
        newer.SetResult(2);
        Assert.Equal(2, await joined);
        older.SetResult(1);
        Assert.Equal(1, await orphaned);
        await using var reader = key.GetAsyncEnumerator(deadline.Token);
        Assert.True(await reader.MoveNextAsync());
        Assert.Equal(1, Assert.IsType<CacheState<int>.Ready>(reader.Current).Value);
        Assert.False(loads.Reader.TryPeek(out _));

        var fresh = key.FreshAsync(deadline.Token);
        (await loads.Reader.ReadAsync(deadline.Token)).SetException(new InvalidOperationException("unavailable"));
        await Assert.ThrowsAsync<InvalidOperationException>(() => fresh);
        Assert.False(loads.Reader.TryPeek(out _));
        await using var after = key.GetAsyncEnumerator(deadline.Token);
        Assert.True(await after.MoveNextAsync());
        Assert.Equal(1, Assert.IsType<CacheState<int>.Ready>(after.Current).Value);
    }
}
