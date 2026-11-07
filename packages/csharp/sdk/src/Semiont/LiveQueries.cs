using System.Text.Json;
using Semiont.Errors;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont;

/// <summary>An engine configured in the knowledge base and the limits its service reported.</summary>
public sealed record EngineWithLimits(EngineEntry Entry, InferenceLimits? Limits);

internal sealed class LiveQueries : IDisposable
{
    internal readonly record struct Filters(long Limit, long Offset, bool? Archived, string? EntityType);
    internal readonly record struct Search(string Text, Filters Filters);
    internal readonly record struct AnnotationKey(ResourceId Resource, AnnotationId Annotation);

    private static readonly JsonDocument Table = JsonDocument.Parse(ProtocolTables.CacheRefresh);
    private static readonly string[] RowMembers = ["on", "when", "reach", "names", "carries", "refetches", "writes", "removes", "docs"];
    private static readonly string[] NamedSlots = ["resource", "annotation"];
    private const string Reopened = "reopened";
    private const string Unreadable = "unreadable";
    private readonly EventBus.Subscription events;
    private readonly Dictionary<string, Query> queries;
    private readonly ILookup<string, JsonElement> refresh;
    private readonly IDisposable[] caches;
    private readonly LiveCacheStorage? persistence;

    internal Cache<ResourceId, ResourceDescriptor> ResourcesById { get; }
    internal Cache<Filters, ListResourcesResponse> Resources { get; }
    internal Cache<ResourceId, IReadOnlyList<Annotation>> Annotations { get; }
    internal Cache<AnnotationKey, Annotation> Annotation { get; }
    internal Cache<ResourceId, IReadOnlyList<AttributedEvent>> Events { get; }
    internal Cache<ResourceId, IReadOnlyList<GetReferencedByResponseReferencedByItem>> ReferencedBy { get; }
    internal Cache<Search, MatchResourcesResponse> MatchedResources { get; }
    internal Cached<IReadOnlyList<string>> EntityTypes { get; }
    internal Cached<IReadOnlyList<TagSchema>> TagSchemas { get; }
    internal Cached<IReadOnlyList<EngineWithLimits>> Engines { get; }

    internal LiveQueries(Bus wire, EventBus bus, HttpTransport transport, HttpContentTransport content, CachePersistence? storage)
    {
        var clock = transport.Clock;
        persistence = storage is null ? null : new LiveCacheStorage(storage, clock);
        Action? changed = persistence is { } persisted ? persisted.Changed : null;
        Func<bool>? pending = persistence is { } storageState ? () => storageState.Pending : null;
        var window = TimeSpan.FromMilliseconds(transport.Settings.InvalidationWindowMs);
        ResourcesById = new(async (id, token) => (await wire.RequestAsync(BusOperations.BrowseResourceRequested,
            new BrowseResourceRequest { ResourceId = id }, cancellation: token).ConfigureAwait(false)).Response.Resource, transport.SubscribeToResource, clock, window, changed, pending);
        Resources = new(async (filters, token) => (await wire.RequestAsync(BusOperations.BrowseResourcesRequested,
            new BrowseResourcesRequest { Limit = filters.Limit, Offset = filters.Offset, Archived = filters.Archived, EntityType = filters.EntityType },
            cancellation: token).ConfigureAwait(false)).Response, null, clock, window);
        Annotations = new(async (id, token) => (await content.GetAnnotationsAsync(id, token).ConfigureAwait(false)).Annotations,
            transport.SubscribeToResource, clock, window, changed, pending);
        Annotation = new(async (key, token) => (await wire.RequestAsync(BusOperations.BrowseAnnotationRequested,
            new BrowseAnnotationRequest { ResourceId = key.Resource, AnnotationId = key.Annotation }, cancellation: token)
            .ConfigureAwait(false)).Response.Annotation, key => transport.SubscribeToResource(key.Resource), clock, window, changed, pending);
        Events = new(async (id, token) => (await wire.RequestAsync(BusOperations.BrowseEventsRequested,
            new BrowseEventsRequest { ResourceId = id }, cancellation: token).ConfigureAwait(false)).Response.Events, transport.SubscribeToResource, clock, window);
        ReferencedBy = new(async (id, token) => (await wire.RequestAsync(BusOperations.GatherReferencedByRequested,
            new GatherReferencedByRequest { ResourceId = id }, cancellation: token).ConfigureAwait(false)).Response.ReferencedBy, transport.SubscribeToResource, clock, window);
        MatchedResources = new(async (search, token) => (await wire.RequestAsync(BusOperations.MatchResourcesRequested, new MatchResourcesRequest
        {
            Search = search.Text,
            Limit = search.Filters.Limit,
            Offset = search.Filters.Offset,
            Archived = search.Filters.Archived,
            EntityType = search.Filters.EntityType,
        }, cancellation: token).ConfigureAwait(false)).Response, null, clock, window);

        var entityTypes = Singleton<IReadOnlyList<string>>(async token => (await wire.RequestAsync(BusOperations.BrowseEntityTypesRequested,
            new BrowseEntityTypesRequest(), cancellation: token).ConfigureAwait(false)).Response.EntityTypes, out var types, changed);
        EntityTypes = types;
        var tagSchemas = Singleton<IReadOnlyList<TagSchema>>(async token => (await wire.RequestAsync(BusOperations.BrowseTagSchemasRequested,
            new BrowseTagSchemasRequest(), cancellation: token).ConfigureAwait(false)).Response.TagSchemas, out var tags, changed);
        TagSchemas = tags;
        var engines = Singleton(token => LoadEnginesAsync(wire, token), out var listed);
        Engines = listed;

        caches = [ResourcesById, Resources, Annotations, Annotation, Events, ReferencedBy, MatchedResources, entityTypes, tagSchemas, engines];
        queries = new(StringComparer.Ordinal)
        {
            ["resource"] = new(Refetch(ResourcesById, ResourceMatches)),
            ["resources"] = new(Refetch(Resources, (_, _) => true)),
            ["annotations"] = new(Refetch(Annotations, ResourceMatches), WriteAnnotations),
            ["annotation"] = new(Refetch(Annotation, AnnotationMatches), WriteAnnotation, RemoveAnnotation),
            ["events"] = new(Refetch(Events, ResourceMatches)),
            ["referencedBy"] = new(Refetch(ReferencedBy, ResourceMatches)),
            ["matchedResources"] = new(Refetch(MatchedResources, (_, _) => true)),
            ["entityTypes"] = new((_, _) => EntityTypes.Refresh()),
            ["tagSchemas"] = new((_, _) => TagSchemas.Refresh()),
            ["engines"] = new((_, _) => Engines.Refresh()),
        };

        refresh = Table.RootElement.GetProperty("refresh").EnumerateArray().ToLookup(row => Text(row, "on"), StringComparer.Ordinal);
        CheckRefresh();
        var channels = refresh.Select(group => group.Key).Where(BusChannels.Readings.ContainsKey);
        if (persistence is not null) channels = channels.Concat(ProtocolFacts.Channels("scoped")).Distinct(StringComparer.Ordinal);
        events = bus.Listen(channels.ToArray());
        persistence?.Start(transport, [ResourcesById.PersistAs("resource"), Annotations.PersistAs("annotations"),
            Annotation.PersistAs("annotation"), entityTypes.PersistAs("entityTypes"), tagSchemas.PersistAs("tagSchemas")]);
        _ = ReadEventsAsync();
        _ = ReadReopensAsync(transport);

        Cache<bool, T> Singleton<T>(Func<CancellationToken, Task<T>> fetch, out Cached<T> query, Action? saved = null)
        {
            var cache = new Cache<bool, T>((_, token) => fetch(token), null, clock, window, saved, saved is not null ? pending : null);
            query = cache.Observe(true);
            return cache;
        }
    }

    private static async Task<IReadOnlyList<EngineWithLimits>> LoadEnginesAsync(Bus wire, CancellationToken cancellation)
    {
        var inventory = wire.RequestAsync(BusOperations.BrowseEnginesRequested, new BrowseEnginesRequest(), cancellation: cancellation);
        var reportsTask = Task.WhenAll(BusOperations.Limits.Select(ReadLimitsAsync));
        await Task.WhenAll(inventory, reportsTask).ConfigureAwait(false);
        var result = await inventory.ConfigureAwait(false);
        var reports = await reportsTask.ConfigureAwait(false);
        var limits = new Dictionary<Engine, InferenceLimits>();
        foreach (var report in reports)
            foreach (var entry in report) limits[entry.Engine] = entry.Limits;
        return result.Response.Engines.Select(entry => new EngineWithLimits(entry, limits.GetValueOrDefault(entry.Engine))).ToArray();

        async Task<IReadOnlyList<EngineLimits>> ReadLimitsAsync(BusOperation<InferenceLimitsRequest, InferenceLimitsResult, CommandError> operation)
        {
            try
            {
                return (await wire.RequestAsync(operation, new InferenceLimitsRequest(), cancellation: cancellation)
                    .ConfigureAwait(false)).Response.Limits;
            }
            catch (SemiontError) { return []; }
        }
    }

    private static bool ResourceMatches(ResourceId resource, Subject subject) => subject.Resource == resource;

    private static bool AnnotationMatches(AnnotationKey key, Subject subject) =>
        subject.Annotation is { } annotation ? annotation == key.Annotation && (subject.Resource is null || subject.Resource == key.Resource)
            : subject.Resource == key.Resource;

    private static Action<Subject, bool> Refetch<TKey, T>(Cache<TKey, T> cache, Func<TKey, Subject, bool> matches) where TKey : notnull =>
        (subject, all) =>
        {
            foreach (var pair in cache.Snapshot())
                if (all || matches(pair.Key, subject)) pair.Value.Refresh();
        };

    private void WriteAnnotations(Subject subject)
    {
        if (subject.Resource is not { } resource || subject.Written is not { } written) return;
        Annotations.Find(resource)?.UpdateIfReady(items =>
        {
            var values = items.ToList();
            var index = values.FindIndex(item => item.Id == written.Id);
            if (index < 0) values.Add(written);
            else values[index] = written;
            return values.ToArray();
        });
    }

    private void WriteAnnotation(Subject subject)
    {
        if (subject.Resource is { } resource && subject.Written is { } written)
            Annotation.Find(new AnnotationKey(resource, written.Id))?.Set(written, onlyIfHeld: true);
    }

    private void RemoveAnnotation(Subject subject)
    {
        if (subject.Annotation is null) return;
        foreach (var pair in Annotation.Snapshot())
            if (AnnotationMatches(pair.Key, subject)) pair.Value.Remove(onlyIfHeld: true);
    }

    private void CheckRefresh()
    {
        var named = Table.RootElement.GetProperty("queries").EnumerateArray().Select(row => Text(row, "name"));
        var unheard = refresh.Select(group => group.Key).Where(trigger => !BusChannels.Readings.ContainsKey(trigger));
        if (!queries.Keys.ToHashSet(StringComparer.Ordinal).SetEquals(named) ||
            !unheard.ToHashSet(StringComparer.Ordinal).SetEquals([Reopened, Unreadable]))
            throw new InvalidOperationException("The live cache does not cover the refresh table.");
        foreach (var group in refresh)
            foreach (var row in group)
            {
                foreach (var member in row.EnumerateObject())
                    if (!RowMembers.Contains(member.Name, StringComparer.Ordinal))
                        throw new InvalidOperationException("A refresh row states " + member.Name + ", which the live cache does not read.");
                if (row.TryGetProperty("names", out var names))
                    foreach (var slot in names.EnumerateObject())
                        if (!NamedSlots.Contains(slot.Name, StringComparer.Ordinal))
                            throw new InvalidOperationException("A refresh row names a " + slot.Name + ", which the live cache does not read.");
                var reach = OptionalText(row, "reach");
                var when = OptionalText(row, "when");
                if (reach is not (null or "held") || when is not (null or "enriched" or "unenriched"))
                    throw new InvalidOperationException("Unknown cache refresh reach or variant.");
                foreach (var name in Names(row, "refetches")) _ = queries[name];
                foreach (var name in Names(row, "writes"))
                    if (queries[name].Write is null) throw new InvalidOperationException("No cache write for " + name);
                foreach (var name in Names(row, "removes"))
                    if (queries[name].Remove is null) throw new InvalidOperationException("No cache removal for " + name);
            }
    }

    private async Task ReadEventsAsync()
    {
        await foreach (var carried in events.Reader.ReadAllAsync().ConfigureAwait(false))
        {
            if (persistence is null) Apply(carried);
            else persistence.Apply(carried, () => Apply(carried));
        }
    }

    private void Apply(Carried carried)
    {
        if (!refresh.Contains(carried.Channel)) return;
        // A frame that cannot be read could be of anything held.
        if (SubjectOf(carried) is not { } subject)
        {
            Refresh(Unreadable, new Subject());
            return;
        }
        Refresh(carried.Channel, subject);
    }

    /// <summary>What a frame on one of the table's channels names, by the ways of its row. None for a frame refused, one
    /// whose payload its channel's typed read refuses, or one where a member a way passes through or ends at is present
    /// and not what the way names.</summary>
    private Subject? SubjectOf(Carried carried)
    {
        if (carried is not ReceivedBusFrame { Frame.Payload: var payload } || !BusChannels.Readings[carried.Channel](carried)) return null;
        try
        {
            var row = RowOf(carried.Channel, payload);
            return new Subject(
                Resource: MemberAt(payload, Named(row, "resource"))?.Deserialize<ResourceId>(),
                Annotation: MemberAt(payload, Named(row, "annotation"))?.Deserialize<AnnotationId>(),
                Written: MemberAt(payload, OptionalText(row, "carries"))?.Deserialize<Annotation>(),
                When: OptionalText(row, "when"));
        }
        catch (JsonException) { return null; }
    }

    /// <summary>A channel's row: of a split channel, the enriched one where the member it carries is present and not
    /// null.</summary>
    private JsonElement RowOf(string channel, JsonElement payload)
    {
        var rows = refresh[channel];
        if (rows.All(row => OptionalText(row, "when") is null)) return rows.Single();
        var enriched = rows.Single(row => OptionalText(row, "when") == "enriched");
        return MemberAt(payload, OptionalText(enriched, "carries")) is null
            ? rows.Single(row => OptionalText(row, "when") == "unenriched")
            : enriched;
    }

    /// <summary>The member <paramref name="way"/> ends at: none where the way is absent, or it or a member it passes
    /// through is absent or null. Throws JsonException where a member it passes through is present and no object.</summary>
    private static JsonElement? MemberAt(JsonElement payload, string? way)
    {
        if (way is null) return null;
        var member = payload;
        foreach (var name in way.Split('.'))
        {
            if (member.ValueKind == JsonValueKind.Null) return null;
            if (member.ValueKind != JsonValueKind.Object) throw new JsonException("The event's " + way + " passes through a member that is no object.");
            if (!member.TryGetProperty(name, out var within)) return null;
            member = within;
        }
        return member.ValueKind == JsonValueKind.Null ? null : member;
    }

    private static string? Named(JsonElement row, string slot) => row.TryGetProperty("names", out var names) ? OptionalText(names, slot) : null;

    private async Task ReadReopensAsync(HttpTransport transport)
    {
        var opened = false;
        var left = false;
        await foreach (var state in transport.States().ConfigureAwait(false))
        {
            if (state != ConnectionState.Open) { left = opened; continue; }
            if (left) Refresh(Reopened, new Subject());
            opened = true;
            left = false;
        }
    }

    private void Refresh(string trigger, Subject subject)
    {
        foreach (var row in refresh[trigger])
        {
            if (OptionalText(row, "when") != subject.When) continue;
            foreach (var name in Names(row, "writes")) queries[name].Write?.Invoke(subject);
            foreach (var name in Names(row, "removes")) queries[name].Remove?.Invoke(subject);
            foreach (var name in Names(row, "refetches")) queries[name].Refetch(subject, OptionalText(row, "reach") == "held");
        }
    }

    private static string Text(JsonElement row, string name) =>
        row.GetProperty(name).GetString() ?? throw new InvalidOperationException("Missing refresh member " + name);
    private static string? OptionalText(JsonElement row, string name) => row.TryGetProperty(name, out var value) ? value.GetString() : null;
    private static IEnumerable<string> Names(JsonElement row, string action) =>
        row.TryGetProperty(action, out var values)
            ? values.EnumerateArray().Select(value => value.GetString() ?? throw new InvalidOperationException("Missing refresh query."))
            : [];

    public void Dispose()
    {
        events.Dispose();
        persistence?.Dispose();
        foreach (var cache in caches) cache.Dispose();
    }

    private sealed record Subject(ResourceId? Resource = null, AnnotationId? Annotation = null, Annotation? Written = null, string? When = null);
    private sealed record Query(Action<Subject, bool> Refetch, Action<Subject>? Write = null, Action<Subject>? Remove = null);
}
