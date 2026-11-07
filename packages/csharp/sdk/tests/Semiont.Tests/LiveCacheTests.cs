using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading.Channels;
using Semiont.Errors;
using Semiont.Identifiers;
using Semiont.Http;
using Semiont.Storage;
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
    public async Task APlaceIsKeptOnlyOnceTheValuesItsEventRefetchesHaveSettled(bool settles)
    {
        var clock = new TestClock();
        var store = new MemoryStorage();
        using var storage = new LiveCacheStorage(new CachePersistence(store, "kb-1"), clock, () => false);
        var answer = new TaskCompletionSource<ResourceDescriptor>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cache = new Cache<ResourceId, ResourceDescriptor>((_, cancellation) => answer.Task.WaitAsync(cancellation), null,
            clock, TimeSpan.Zero, storage.Changed("resource"));
        storage.Start([storage.Keep("resource", cache, KeptKeys.ByResource<ResourceDescriptor>())]);

        var resource = ResourceId.Parse("res-1");
        cache.Set(resource, Described("one"));
        var frame = new ReceivedBusFrame(new BusFrame
        {
            Channel = BusChannels.MarkAdded.Name,
            Scope = resource,
            Payload = JsonSerializer.SerializeToElement(new { }),
        }, default)
        { EventId = "p-res-1-1" };
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        Task<ResourceDescriptor>? refresh = null;
        storage.Apply(frame, () => refresh = cache.FetchAsync(resource, deadline.Token));
        if (settles)
        {
            answer.SetResult(Described("two"));
            Assert.Equal("two", (await Assert.IsAssignableFrom<Task<ResourceDescriptor>>(refresh)).Name);
        }
        storage.Dispose();

        using var saved = JsonDocument.Parse(Assert.IsType<string>(store.Get(KeptTable.DocumentKey("kb-1", "resource"))));
        var entry = Assert.Single(saved.RootElement.GetProperty("entries").EnumerateArray());
        Assert.Equal("res-1", entry[0].GetString());
        Assert.Equal(settles ? "two" : "one", entry[1].GetProperty("name").GetString());
        var places = store.Get(KeptTable.PlacesKey("kb-1"));
        if (settles) Assert.Equal("""{"res-1":"p-res-1-1"}""", places);
        else Assert.Null(places);
    }

    [Fact]
    public void APlaceIsNotKeptWhileTheRefresherOwesARefetch()
    {
        var clock = new TestClock();
        var store = new MemoryStorage();
        var owed = true;
        using var storage = new LiveCacheStorage(new CachePersistence(store, "kb-1"), clock, () => owed);
        using var cache = new Cache<ResourceId, ResourceDescriptor>((_, _) => throw new InvalidOperationException("Nothing is fetched."), null,
            clock, TimeSpan.Zero, storage.Changed("resource"));
        storage.Start([storage.Keep("resource", cache, KeptKeys.ByResource<ResourceDescriptor>())]);
        var resource = ResourceId.Parse("res-1");
        storage.Apply(new ReceivedBusFrame(new BusFrame { Channel = BusChannels.MarkAdded.Name, Scope = resource, Payload = JsonSerializer.SerializeToElement(new { }) }, default)
        { EventId = "p-res-1-1" }, () => cache.Set(resource, Described("one")));
        Assert.True(cache.PersistencePending);

        clock.Advance(LiveCacheStorage.Debounce);
        Assert.False(cache.PersistencePending);
        Assert.NotNull(store.Get(KeptTable.DocumentKey("kb-1", "resource")));
        Assert.Null(store.Get(KeptTable.PlacesKey("kb-1")));

        owed = false;
        cache.Set(resource, Described("two"));
        clock.Advance(LiveCacheStorage.Debounce);
        Assert.Equal("""{"res-1":"p-res-1-1"}""", store.Get(KeptTable.PlacesKey("kb-1")));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void DisposalFlushesEveryDocumentAndKeepsThePlacesOnlyWhenNoRefetchIsOwed(bool refetchOwed)
    {
        var clock = new TestClock();
        var store = new MemoryStorage();
        var flushing = new FlushingStorage(store);
        using var events = new Cache<ResourceId, int>((_, _) => Task.FromResult(2), null, clock, TimeSpan.FromSeconds(1));
        using var storage = new LiveCacheStorage(new CachePersistence(flushing, "kb-1"), clock, () => ((IRefreshedCache)events).RefetchOwed);
        using var resources = new Cache<ResourceId, ResourceDescriptor>((_, _) => throw new InvalidOperationException("Nothing is fetched."), null,
            clock, TimeSpan.Zero, storage.Changed("resource"));
        using var types = new Cache<bool, IReadOnlyList<string>>((_, _) => throw new InvalidOperationException("Nothing is fetched."), null,
            clock, TimeSpan.Zero, storage.Changed("entityTypes"));
        storage.Start([storage.Keep("resource", resources, KeptKeys.ByResource<ResourceDescriptor>()),
            storage.Keep("entityTypes", types, KeptKeys.Whole<IReadOnlyList<string>>())]);
        var resource = ResourceId.Parse("res-1");
        storage.Apply(new ReceivedBusFrame(new BusFrame { Channel = BusChannels.MarkAdded.Name, Scope = resource, Payload = JsonSerializer.SerializeToElement(new { }) }, default)
        { EventId = "p-res-1-7" }, () =>
        {
            resources.Set(resource, Described("one"));
            types.Set(true, ["Person"]);
        });
        if (refetchOwed)
        {
            events.Set(resource, 1);
            events.Entry(resource).Refresh();
            events.Entry(resource).Refresh();
        }
        var later = false;
        flushing.During = () => storage.Apply(new ReceivedBusFrame(new BusFrame
        {
            Channel = BusChannels.MarkAdded.Name,
            Scope = ResourceId.Parse("res-2"),
            Payload = JsonSerializer.SerializeToElement(new { }),
        }, default)
        { EventId = "p-res-2-9" }, () => later = true);

        storage.Dispose();

        Assert.False(later);
        Assert.NotNull(store.Get(KeptTable.DocumentKey("kb-1", "resource")));
        Assert.NotNull(store.Get(KeptTable.DocumentKey("kb-1", "entityTypes")));
        var places = store.Get(KeptTable.PlacesKey("kb-1"));
        if (refetchOwed) Assert.Null(places);
        else Assert.Equal("""{"res-1":"p-res-1-7"}""", places);
    }

    [Fact]
    public async Task ARehydratedAnnotationIsHeldUnderTheResourceItTargets()
    {
        var store = new MemoryStorage();
        store.Set(KeptTable.DocumentKey("kb-1", "annotation"), """
            {"version":1,"entries":[["ann-1",{"@context":"http://www.w3.org/ns/anno.jsonld","type":"Annotation","id":"ann-1","motivation":"highlighting","target":{"source":"res-1"},"created":"2026-01-01T00:00:00.000Z"},1000]]}
            """);
        using var storage = new LiveCacheStorage(new CachePersistence(store, "kb-1"), TimeProvider.System, () => false);
        var never = new TaskCompletionSource<Annotation>();
        using var cache = new Cache<LiveQueries.AnnotationKey, Annotation>((_, cancellation) => never.Task.WaitAsync(cancellation), null,
            TimeProvider.System, TimeSpan.Zero, storage.Changed("annotation"));
        storage.Start([storage.Keep("annotation", cache, KeptKeys.ByAnnotation)]);

        var annotation = AnnotationId.Parse("ann-1");
        Assert.Null(cache.Get(new LiveQueries.AnnotationKey(ResourceId.Parse("res-2"), annotation)));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var observer = cache.Observe(new LiveQueries.AnnotationKey(ResourceId.Parse("res-1"), annotation)).GetAsyncEnumerator(deadline.Token);
        Assert.True(await observer.MoveNextAsync());
        Assert.Equal(annotation, Assert.IsType<CacheState<Annotation>.Ready>(observer.Current).Value.Id);
    }

    [Theory]
    [InlineData("""{"version":99,"entries":[]}""")]
    [InlineData("""{"version":1,"entries":[["res-1",{"name":"Not a resource"},1000]]}""")]
    [InlineData("invalid JSON")]
    public async Task InvalidPersistenceStartsEmpty(string document)
    {
        var store = new MemoryStorage();
        store.Set(KeptTable.DocumentKey("kb-1", "resource"), document);
        using var storage = new LiveCacheStorage(new CachePersistence(store, "kb-1"), TimeProvider.System, () => false);
        using var cache = new Cache<ResourceId, ResourceDescriptor>((_, _) => Task.FromResult(Described("fetched")), null,
            TimeProvider.System, TimeSpan.Zero, storage.Changed("resource"));
        storage.Start([storage.Keep("resource", cache, KeptKeys.ByResource<ResourceDescriptor>())]);

        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var observer = cache.Observe(ResourceId.Parse("res-1")).GetAsyncEnumerator(deadline.Token);
        Assert.True(await observer.MoveNextAsync());
        Assert.IsType<CacheState<ResourceDescriptor>.Pending>(observer.Current);
        Assert.True(await observer.MoveNextAsync());
        Assert.Equal("fetched", Assert.IsType<CacheState<ResourceDescriptor>.Ready>(observer.Current).Value.Name);
    }

    /// <summary>A storage that runs <see cref="During"/> at its first write after it is set: within a flush, after the
    /// flush has read its gate.</summary>
    private sealed class FlushingStorage(MemoryStorage store) : ISessionStorage
    {
        internal Action? During { get; set; }
        public string? Get(string key) => store.Get(key);

        public void Set(string key, string value)
        {
            store.Set(key, value);
            if (During is not { } during) return;
            During = null;
            during();
        }

        public void Delete(string key) => store.Delete(key);
        public void Update(string key, Func<string?, string?> change) => store.Update(key, change);
        public IDisposable? Subscribe(Action<string, string?> onChange) => store.Subscribe(onChange);
    }

    private static ResourceDescriptor Described(string name) => Required<ResourceDescriptor>(JsonSerializer.SerializeToElement(new Dictionary<string, object>
    {
        ["@context"] = "https://schema.org/",
        ["@id"] = "res-1",
        ["name"] = name,
        ["representations"] = Array.Empty<object>(),
    }));

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
