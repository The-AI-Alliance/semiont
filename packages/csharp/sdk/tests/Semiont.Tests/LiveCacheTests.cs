using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using System.Threading.Channels;
using Semiont.Errors;
using Semiont.Identifiers;
using Semiont.Http;
using Semiont.Protocol;
using Semiont.Registry;
using Semiont.Storage;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

public sealed partial class TransportTests
{
    private static readonly string KeptPersonKey = RegistryStorage.PersonKey(UserId.Parse("did:web:kb.example.org:users:jo%40example.org"));

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

    // client/refresh.json's `value` owns what each live query's cache holds for a key: the generated type of the
    // component it names, or of the member within one, is the type of the query's values here.
    [Fact]
    public void EveryLiveQueryHoldsTheValueItsRefreshRowNames()
    {
        var held = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["resource"] = nameof(LiveQueries.ResourcesById),
            ["annotations"] = nameof(LiveQueries.Annotations),
            ["annotation"] = nameof(LiveQueries.Annotation),
            ["events"] = nameof(LiveQueries.Events),
            ["referencedBy"] = nameof(LiveQueries.ReferencedBy),
            ["resources"] = nameof(LiveQueries.Resources),
            ["matchedResources"] = nameof(LiveQueries.MatchedResources),
            ["entityTypes"] = nameof(LiveQueries.EntityTypes),
            ["tagSchemas"] = nameof(LiveQueries.TagSchemas),
            ["engines"] = nameof(LiveQueries.Engines),
        };
        using var table = ReadSpec("client/refresh.json");
        var rows = table.RootElement.GetProperty("queries").EnumerateArray().ToArray();
        Assert.Equal(rows.Select(row => Text(row, "name")).Order(StringComparer.Ordinal), held.Keys.Order(StringComparer.Ordinal));
        foreach (var row in rows)
        {
            var name = Text(row, "name");
            var query = typeof(LiveQueries).GetProperty(held[name], BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                ?? throw new InvalidOperationException("The live queries have no " + held[name]);
            var value = query.PropertyType.GetGenericArguments()[^1];
            var named = Text(row.GetProperty("value"), "$ref");
            Assert.True(GeneratedType(named) == value, name + " holds " + value + ", and its row names " + named);
        }

        // The generated type of a component, or of the member within one that the reference's pointer names.
        static Type GeneratedType(string reference)
        {
            var parts = reference.Split('#');
            var type = typeof(ResourceDescriptor).Assembly.GetType("Semiont.Types." + Path.GetFileNameWithoutExtension(parts[0]), throwOnError: true)
                ?? throw new InvalidOperationException("No generated type for " + reference);
            if (parts.Length == 1) return type;
            var steps = parts[1].Split('/', StringSplitOptions.RemoveEmptyEntries);
            for (var at = 0; at < steps.Length; at += 2)
            {
                if (steps[at] != "properties" || at + 1 == steps.Length) throw new InvalidOperationException(reference + " names no member");
                type = type.GetProperty(steps[at + 1], BindingFlags.Instance | BindingFlags.Public | BindingFlags.IgnoreCase)?.PropertyType
                    ?? throw new InvalidOperationException(type + " has no member " + steps[at + 1]);
            }
            return type;
        }
    }

    // B17 item 2: an event's place is noted only once the refresher has taken the event. Here the event arrives while a
    // save holds the persistence, so the refresher cannot yet take it: the save writes no place for it. Once the refresher
    // has taken it, its refetch in flight holds the place back from a save; once that refetch has settled, a save writes it.
    [Fact]
    public async Task APlaceIsNotedOnlyOnceTheRefresherHasTakenItsEvent()
    {
        var clock = new TestClock();
        var resourceKey = RegistryStorage.CacheKey("kb-1", KeptPersonKey, "resource");
        var typesKey = RegistryStorage.CacheKey("kb-1", KeptPersonKey, "entityTypes");
        var placesKey = RegistryStorage.LastEventIdKey("kb-1", KeptPersonKey);
        using var storage = new HeldWriteStorage(resourceKey);
        using var server = new Handler();
        var refetches = Channel.CreateUnbounded<JsonElement>();
        var asks = new ConcurrentDictionary<string, int>(StringComparer.Ordinal);
        server.Answer = sent =>
        {
            if (Text(sent, "channel") == BusOperations.BrowseEntityTypesRequested.Request.Name)
            {
                Reply(server, sent, BusOperations.BrowseEntityTypesRequested.Result.Name, new { response = new { entityTypes = new[] { "Person" } } });
                return;
            }
            Assert.Equal(BusOperations.BrowseResourceRequested.Request.Name, Text(sent, "channel"));
            var id = Text(sent.GetProperty("payload"), "resourceId");
            // The first ask is answered at once; a refetch waits for the test.
            if (asks.AddOrUpdate(id, 1, (_, count) => count + 1) > 1) refetches.Writer.TryWrite(sent);
            else Reply(server, sent, BusOperations.BrowseResourceRequested.Result.Name, new { response = new { resource = Described(id, "fresh"), lastSequence = 1 } });
        };
        using var http = new HttpClient(server);
        using var client = new SemiontClient("http://unit.test", "token", http, clock, persistence: new CachePersistence(storage, "kb-1", KeptPersonKey));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(client.Transport);
        var resource = ResourceId.Parse("res-1");
        Assert.Equal("fresh", (await client.Browse.Resource(resource).FreshAsync(deadline.Token)).Name);

        await clock.WaitForAsync(LiveCacheStorage.Debounce);
        // The debounce's save runs on the thread that passes it, and is held there, holding the persistence.
        var saving = Task.Run(() => clock.Advance(LiveCacheStorage.Debounce), deadline.Token);
        await storage.Writing.Task.WaitAsync(deadline.Token);
        await using (var heard = client.Transport.Frames(BusChannels.MarkArchived.Name, deadline.Token).GetAsyncEnumerator())
        {
            var arrived = heard.MoveNextAsync().AsTask();
            server.Stream.Push("event: bus-event\nid: p-res-1-5\ndata: " + JsonSerializer.Serialize(new
            {
                channel = BusChannels.MarkArchived.Name,
                scope = resource.Value,
                payload = new
                {
                    id = "evt-res-1-5",
                    type = BusChannels.MarkArchived.Name,
                    timestamp = "1970-01-01T00:00:00.000Z",
                    userId = "did:web:record.example:users:someone",
                    resourceId = resource.Value,
                    version = 1,
                    payload = new { },
                    metadata = new { sequenceNumber = 5 },
                },
            }) + "\n\n");
            Assert.True(await arrived);
        }
        storage.Release();
        await saving.WaitAsync(deadline.Token);
        Assert.True(HoldsFresh(storage.Get(resourceKey), "res-1"), "the held save wrote the resource");
        Assert.True(storage.Get(placesKey) is null, "a save the event arrived during wrote its place: " + storage.Get(placesKey));

        var refetch = await refetches.Reader.ReadAsync(deadline.Token);
        Assert.Equal(["Person"], await client.Browse.EntityTypes().FreshAsync(deadline.Token));
        await clock.WaitForAsync(LiveCacheStorage.Debounce);
        clock.Advance(LiveCacheStorage.Debounce);
        Assert.True(storage.Get(typesKey) is not null, "a kept query saved while the refetch was in flight");
        Assert.True(storage.Get(placesKey) is null, "a save during the event's refetch wrote its place: " + storage.Get(placesKey));

        var refetched = client.Browse.Resource(resource).FreshAsync(deadline.Token);
        Reply(server, refetch, BusOperations.BrowseResourceRequested.Result.Name, new { response = new { resource = Described("res-1", "archived"), lastSequence = 2 } });
        Assert.Equal("archived", (await refetched).Name);
        await clock.WaitForAsync(LiveCacheStorage.Debounce);
        clock.Advance(LiveCacheStorage.Debounce);
        Assert.Equal("""{"res-1":"p-res-1-5"}""", storage.Get(placesKey));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task APlaceIsKeptOnlyOnceTheValuesItsEventRefetchesHaveSettled(bool settles)
    {
        var clock = new TestClock();
        var store = new MemoryStorage();
        using var storage = new LiveCacheStorage(new CachePersistence(store, "kb-1", KeptPersonKey), clock, () => false);
        var answer = new TaskCompletionSource<ResourceDescriptor>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cache = new Cache<ResourceId, ResourceDescriptor>((_, cancellation) => answer.Task.WaitAsync(cancellation), null,
            clock, TimeSpan.Zero, storage.Changed("resource"));
        storage.Start([storage.Keep("resource", cache, KeptKeys.ByResource<ResourceDescriptor>())], _ => { });

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

        using var saved = JsonDocument.Parse(Assert.IsType<string>(store.Get(RegistryStorage.CacheKey("kb-1", KeptPersonKey, "resource"))));
        var entry = Assert.Single(saved.RootElement.GetProperty("entries").EnumerateArray());
        Assert.Equal("res-1", entry[0].GetString());
        Assert.Equal(settles ? "two" : "one", entry[1].GetProperty("name").GetString());
        var places = store.Get(RegistryStorage.LastEventIdKey("kb-1", KeptPersonKey));
        if (settles) Assert.Equal("""{"res-1":"p-res-1-1"}""", places);
        else Assert.Null(places);
    }

    [Fact]
    public void APlaceIsNotKeptWhileTheRefresherOwesARefetch()
    {
        var clock = new TestClock();
        var store = new MemoryStorage();
        var owed = true;
        using var storage = new LiveCacheStorage(new CachePersistence(store, "kb-1", KeptPersonKey), clock, () => owed);
        using var cache = new Cache<ResourceId, ResourceDescriptor>((_, _) => throw new InvalidOperationException("Nothing is fetched."), null,
            clock, TimeSpan.Zero, storage.Changed("resource"));
        storage.Start([storage.Keep("resource", cache, KeptKeys.ByResource<ResourceDescriptor>())], _ => { });
        var resource = ResourceId.Parse("res-1");
        storage.Apply(new ReceivedBusFrame(new BusFrame { Channel = BusChannels.MarkAdded.Name, Scope = resource, Payload = JsonSerializer.SerializeToElement(new { }) }, default)
        { EventId = "p-res-1-1" }, () => cache.Set(resource, Described("one")));
        Assert.True(cache.PersistencePending);

        clock.Advance(LiveCacheStorage.Debounce);
        Assert.False(cache.PersistencePending);
        Assert.NotNull(store.Get(RegistryStorage.CacheKey("kb-1", KeptPersonKey, "resource")));
        Assert.Null(store.Get(RegistryStorage.LastEventIdKey("kb-1", KeptPersonKey)));

        owed = false;
        cache.Set(resource, Described("two"));
        clock.Advance(LiveCacheStorage.Debounce);
        Assert.Equal("""{"res-1":"p-res-1-1"}""", store.Get(RegistryStorage.LastEventIdKey("kb-1", KeptPersonKey)));
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
        using var storage = new LiveCacheStorage(new CachePersistence(flushing, "kb-1", KeptPersonKey), clock, () => ((IRefreshedCache)events).RefetchOwed);
        using var resources = new Cache<ResourceId, ResourceDescriptor>((_, _) => throw new InvalidOperationException("Nothing is fetched."), null,
            clock, TimeSpan.Zero, storage.Changed("resource"));
        using var types = new Cache<bool, IReadOnlyList<string>>((_, _) => throw new InvalidOperationException("Nothing is fetched."), null,
            clock, TimeSpan.Zero, storage.Changed("entityTypes"));
        storage.Start([storage.Keep("resource", resources, KeptKeys.ByResource<ResourceDescriptor>()),
            storage.Keep("entityTypes", types, KeptKeys.Whole<IReadOnlyList<string>>())], _ => { });
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
        Assert.NotNull(store.Get(RegistryStorage.CacheKey("kb-1", KeptPersonKey, "resource")));
        Assert.NotNull(store.Get(RegistryStorage.CacheKey("kb-1", KeptPersonKey, "entityTypes")));
        var places = store.Get(RegistryStorage.LastEventIdKey("kb-1", KeptPersonKey));
        if (refetchOwed) Assert.Null(places);
        else Assert.Equal("""{"res-1":"p-res-1-7"}""", places);
    }

    [Fact]
    public async Task ARehydratedAnnotationIsHeldUnderTheResourceItTargets()
    {
        var store = new MemoryStorage();
        store.Set(RegistryStorage.CacheKey("kb-1", KeptPersonKey, "annotation"), """
            {"version":1,"entries":[["ann-1",{"@context":"http://www.w3.org/ns/anno.jsonld","type":"Annotation","id":"ann-1","motivation":"highlighting","target":{"source":"res-1"},"created":"2026-01-01T00:00:00.000Z"},1000]]}
            """);
        using var storage = new LiveCacheStorage(new CachePersistence(store, "kb-1", KeptPersonKey), TimeProvider.System, () => false);
        var never = new TaskCompletionSource<Annotation>();
        using var cache = new Cache<LiveQueries.AnnotationKey, Annotation>((_, cancellation) => never.Task.WaitAsync(cancellation), null,
            TimeProvider.System, TimeSpan.Zero, storage.Changed("annotation"));
        storage.Start([storage.Keep("annotation", cache, KeptKeys.ByAnnotation)], _ => { });

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
        store.Set(RegistryStorage.CacheKey("kb-1", KeptPersonKey, "resource"), document);
        using var storage = new LiveCacheStorage(new CachePersistence(store, "kb-1", KeptPersonKey), TimeProvider.System, () => false);
        using var cache = new Cache<ResourceId, ResourceDescriptor>((_, _) => Task.FromResult(Described("fetched")), null,
            TimeProvider.System, TimeSpan.Zero, storage.Changed("resource"));
        storage.Start([storage.Keep("resource", cache, KeptKeys.ByResource<ResourceDescriptor>())], _ => { });

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
        Assert.Equal(2, Assert.IsType<CacheState<int>.Ready>(reader.Current).Value);
        Assert.False(loads.Reader.TryPeek(out _));

        var fresh = key.FreshAsync(deadline.Token);
        (await loads.Reader.ReadAsync(deadline.Token)).SetException(new InvalidOperationException("unavailable"));
        await Assert.ThrowsAsync<InvalidOperationException>(() => fresh);
        Assert.False(loads.Reader.TryPeek(out _));
        await using var after = key.GetAsyncEnumerator(deadline.Token);
        Assert.True(await after.MoveNextAsync());
        Assert.Equal(2, Assert.IsType<CacheState<int>.Ready>(after.Current).Value);
    }

    // B9: only a key's newest fetch writes. The fetch an invalidate replaced answers whoever awaited it, after the newer
    // one has answered, and stores nothing: no emission, and no save owed.
    [Fact]
    public async Task OnlyTheNewestFetchWritesWhenItAnswersBeforeTheFetchItReplaced()
    {
        using var fetches = new AnsweredFetches();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var key = fetches.Cache.Observe("key");
        await using var reader = key.GetAsyncEnumerator(deadline.Token);
        Assert.True(await reader.MoveNextAsync());
        Assert.IsType<CacheState<int>.Pending>(reader.Current);
        var older = key.FreshAsync(deadline.Token);
        var replaced = await fetches.AskedAsync(deadline.Token);
        key.Invalidate();
        var current = await fetches.AskedAsync(deadline.Token);
        var newer = key.FreshAsync(deadline.Token);

        current.SetResult(1);
        Assert.Equal(1, await newer);
        Assert.True(await reader.MoveNextAsync());
        Assert.Equal(1, Assert.IsType<CacheState<int>.Ready>(reader.Current).Value);
        Assert.Equal(1, fetches.Changes);

        replaced.SetResult(0);
        Assert.Equal(0, await older);
        var next = reader.MoveNextAsync().AsTask();
        Assert.False(next.IsCompleted, "the replaced fetch's answer reached an observer");
        Assert.Equal(1, Assert.IsType<CacheState<int>.Ready>(fetches.Cache.Get("key")).Value);
        Assert.Equal(1, fetches.Changes);
        Assert.True(fetches.Unasked);
        fetches.Cache.Dispose();
        Assert.False(await next);
    }

    // B9: the fetch an invalidate replaced answers first. Its caller has its answer, and the key is as it was until the
    // newer fetch answers.
    [Fact]
    public async Task AFetchAnInvalidateLetGoOfAnswersItsCallerAndStoresNothing()
    {
        using var fetches = new AnsweredFetches();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        fetches.Cache.Set("key", 5);
        var held = Assert.IsType<CacheState<int>.Ready>(fetches.Cache.Get("key"));
        var key = fetches.Cache.Observe("key");
        await using var reader = key.GetAsyncEnumerator(deadline.Token);
        Assert.True(await reader.MoveNextAsync());
        Assert.Same(held, reader.Current);
        var older = key.FreshAsync(deadline.Token);
        var replaced = await fetches.AskedAsync(deadline.Token);
        key.Invalidate();
        var current = await fetches.AskedAsync(deadline.Token);
        var newer = key.FreshAsync(deadline.Token);

        replaced.SetResult(0);
        Assert.Equal(0, await older);
        var next = reader.MoveNextAsync().AsTask();
        Assert.False(next.IsCompleted, "the replaced fetch's answer reached an observer");
        Assert.Same(held, fetches.Cache.Get("key"));
        Assert.Equal(1, fetches.Changes);

        current.SetResult(1);
        Assert.Equal(1, await newer);
        Assert.True(await next);
        Assert.Equal(1, Assert.IsType<CacheState<int>.Ready>(reader.Current).Value);
        Assert.Equal(2, fetches.Changes);
        Assert.True(fetches.Unasked);
    }

    // B17: a key is fetching while its current fetch is unsettled, and a fetch an invalidate replaced counts for nothing,
    // answered or not.
    [Fact]
    public async Task AKeyIsFetchingOnlyWhileItsCurrentFetchHasNotSettled()
    {
        using var fetches = new AnsweredFetches();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var key = fetches.Cache.Observe("key");
        Assert.False(fetches.Cache.Fetching);
        var older = key.FreshAsync(deadline.Token);
        await fetches.AskedAsync(deadline.Token);
        Assert.True(fetches.Cache.Fetching);
        key.Invalidate();
        var current = await fetches.AskedAsync(deadline.Token);
        Assert.True(fetches.Cache.Fetching);
        var newer = key.FreshAsync(deadline.Token);

        current.SetResult(1);
        Assert.Equal(1, await newer);
        Assert.False(fetches.Cache.Fetching);
        Assert.False(older.IsCompleted);
        fetches.Cache.Dispose();
        Assert.Equal("bus.closed", (await Assert.ThrowsAsync<BusRequestError>(() => older)).Code);
    }

    // B13a: a removal ends the key and lets go of its fetch. That fetch's answer reaches whoever awaited it, and the key
    // stays failed with bus.not-found, with nothing stored.
    [Fact]
    public async Task AFetchARemovalLetGoOfStoresNothing()
    {
        using var fetches = new AnsweredFetches();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var key = fetches.Cache.Observe("key");
        await using var reader = key.GetAsyncEnumerator(deadline.Token);
        Assert.True(await reader.MoveNextAsync());
        Assert.IsType<CacheState<int>.Pending>(reader.Current);
        var asked = await fetches.AskedAsync(deadline.Token);
        var awaited = key.FreshAsync(deadline.Token);

        fetches.Cache.Remove("key");
        Assert.True(await reader.MoveNextAsync());
        Assert.Equal("bus.not-found", Assert.IsType<BusRequestError>(Assert.IsType<CacheState<int>.Failed>(reader.Current).Error).Code);
        Assert.Equal(1, fetches.Changes);

        asked.SetResult(0);
        Assert.Equal(0, await awaited);
        var next = reader.MoveNextAsync().AsTask();
        Assert.False(next.IsCompleted, "the removed key's fetch reached an observer");
        Assert.Null(fetches.Cache.Get("key"));
        Assert.Equal(1, fetches.Changes);
        Assert.True(fetches.Unasked);
        fetches.Cache.Dispose();
        Assert.False(await next);
    }

    // B13b: a write lets go of the key's fetch, as a removal does, and asks for nothing. The fetch answers whoever
    // awaited it with its own reply, and stores nothing.
    [Fact]
    public async Task AWriteLetsGoOfTheKeysFetch()
    {
        using var fetches = new AnsweredFetches();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var key = fetches.Cache.Observe("key");
        await using var reader = key.GetAsyncEnumerator(deadline.Token);
        Assert.True(await reader.MoveNextAsync());
        Assert.IsType<CacheState<int>.Pending>(reader.Current);
        var asked = await fetches.AskedAsync(deadline.Token);
        var awaited = key.FreshAsync(deadline.Token);

        fetches.Cache.Set("key", 5);
        Assert.False(fetches.Cache.Fetching);
        Assert.True(await reader.MoveNextAsync());
        Assert.Equal(5, Assert.IsType<CacheState<int>.Ready>(reader.Current).Value);
        Assert.Equal(1, fetches.Changes);

        asked.SetResult(0);
        Assert.Equal(0, await awaited);
        var next = reader.MoveNextAsync().AsTask();
        Assert.False(next.IsCompleted, "the fetch a write let go of reached an observer");
        Assert.Equal(5, Assert.IsType<CacheState<int>.Ready>(fetches.Cache.Get("key")).Value);
        Assert.Equal(1, fetches.Changes);
        Assert.True(fetches.Unasked);
        fetches.Cache.Dispose();
        Assert.False(await next);
    }

    // B13b: a patch to a key whose first fetch is in flight is kept with that fetch, and its reply is stored, and
    // answered, patched.
    [Fact]
    public async Task APatchToAKeyWithNoValueYetRidesOnItsFetch()
    {
        using var fetches = new AnsweredFetches();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var awaited = fetches.Cache.FetchAsync("key", deadline.Token);
        var asked = await fetches.AskedAsync(deadline.Token);

        fetches.Cache.Patch("key", value => value + 1);
        Assert.Null(fetches.Cache.Get("key"));
        Assert.Equal(0, fetches.Changes);

        asked.SetResult(5);
        Assert.Equal(6, await awaited);
        Assert.Equal(6, Assert.IsType<CacheState<int>.Ready>(fetches.Cache.Get("key")).Value);
        Assert.Equal(1, fetches.Changes);
        Assert.True(fetches.Unasked);
    }

    // B13b: patches apply at once to the value the key holds, and again to its fetch's reply, in the order made.
    [Fact]
    public async Task PatchesApplyAtOnceAndToTheFetchsReplyInTheOrderMade()
    {
        using var fetches = new AnsweredFetches();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        fetches.Cache.Set("key", 5);
        var awaited = fetches.Cache.FetchAsync("key", deadline.Token);
        var asked = await fetches.AskedAsync(deadline.Token);

        fetches.Cache.Patch("key", value => value + 1);
        fetches.Cache.Patch("key", value => value * 10);
        Assert.Equal(60, Assert.IsType<CacheState<int>.Ready>(fetches.Cache.Get("key")).Value);
        Assert.Equal(3, fetches.Changes);
        Assert.True(fetches.Cache.Fetching);

        asked.SetResult(7);
        Assert.Equal(80, await awaited);
        Assert.Equal(80, Assert.IsType<CacheState<int>.Ready>(fetches.Cache.Get("key")).Value);
        Assert.Equal(4, fetches.Changes);
        Assert.True(fetches.Unasked);
    }

    // B13b: patches kept with a fetch go with it. The fetch that replaced it is stored as it answers, and the replaced
    // one's reply changes nothing.
    [Fact]
    public async Task AReplacedFetchsPatchesGoWithIt()
    {
        using var fetches = new AnsweredFetches();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var key = fetches.Cache.Observe("key");
        var older = key.FreshAsync(deadline.Token);
        var replaced = await fetches.AskedAsync(deadline.Token);
        fetches.Cache.Patch("key", value => value + 1);
        key.Invalidate();
        var current = await fetches.AskedAsync(deadline.Token);
        var newer = key.FreshAsync(deadline.Token);

        current.SetResult(7);
        Assert.Equal(7, await newer);
        var held = Assert.IsType<CacheState<int>.Ready>(fetches.Cache.Get("key"));
        Assert.Equal(7, held.Value);
        Assert.Equal(1, fetches.Changes);

        replaced.SetResult(5);
        Assert.Equal(5, await older);
        Assert.Same(held, fetches.Cache.Get("key"));
        Assert.Equal(1, fetches.Changes);
        Assert.True(fetches.Unasked);
    }

    // B13b, B20: a patch to a key with neither a value nor a fetch changes nothing, owes no save, and is kept for no
    // later fetch. A key the cache has never been asked for gains no entry by it.
    [Fact]
    public async Task APatchToAKeyWithNeitherValueNorFetchDoesNothing()
    {
        using var fetches = new AnsweredFetches();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        fetches.Cache.Patch("key", value => value + 1);
        Assert.Null(fetches.Cache.Find("key"));
        fetches.Cache.Observe("key");
        fetches.Cache.Patch("key", value => value + 1);
        Assert.Null(fetches.Cache.Get("key"));
        Assert.False(fetches.Cache.Fetching);
        Assert.Equal(0, fetches.Changes);
        Assert.True(fetches.Unasked);

        var awaited = fetches.Cache.FetchAsync("key", deadline.Token);
        (await fetches.AskedAsync(deadline.Token)).SetResult(5);
        Assert.Equal(5, await awaited);
    }

    // B13b, B18: a patch leaves a restored value marked, so the key's first observation still asks for it again.
    [Fact]
    public async Task APatchLeavesARestoredValueMarkedForRevalidation()
    {
        using var fetches = new AnsweredFetches();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var entry = fetches.Cache.Entry("key");
        entry.Rehydrate(5);
        fetches.Cache.Patch("key", value => value + 1);
        Assert.Equal(6, Assert.IsType<CacheState<int>.Ready>(fetches.Cache.Get("key")).Value);
        Assert.True(fetches.Unasked);

        await using var reader = entry.GetAsyncEnumerator(deadline.Token);
        Assert.True(await reader.MoveNextAsync());
        Assert.Equal(6, Assert.IsType<CacheState<int>.Ready>(reader.Current).Value);
        (await fetches.AskedAsync(deadline.Token)).SetResult(9);
        Assert.True(await reader.MoveNextAsync());
        Assert.Equal(9, Assert.IsType<CacheState<int>.Ready>(reader.Current).Value);
    }

    /// <summary>A cache whose every fetch waits for the test to answer it, and which counts each change it owes a save
    /// for: a value it stores, a patch it applies, or a removal.</summary>
    private sealed class AnsweredFetches : IDisposable
    {
        private readonly Channel<TaskCompletionSource<int>> asked = Channel.CreateUnbounded<TaskCompletionSource<int>>();
        private int changes;

        internal AnsweredFetches() =>
            Cache = new Cache<string, int>((_, cancellation) =>
            {
                var answer = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
                asked.Writer.TryWrite(answer);
                return answer.Task.WaitAsync(cancellation);
            }, null, TimeProvider.System, TimeSpan.Zero, () => Interlocked.Increment(ref changes));

        internal Cache<string, int> Cache { get; }
        internal int Changes => Volatile.Read(ref changes);
        internal bool Unasked => !asked.Reader.TryPeek(out _);
        internal ValueTask<TaskCompletionSource<int>> AskedAsync(CancellationToken cancellation) => asked.Reader.ReadAsync(cancellation);
        public void Dispose() => Cache.Dispose();
    }
}
