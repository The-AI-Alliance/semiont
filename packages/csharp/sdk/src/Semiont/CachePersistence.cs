using System.Text;
using System.Text.Json;
using Semiont.Annotations;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.Serialization;
using Semiont.Storage;
using Semiont.Types;

namespace Semiont;

/// <summary>Where a client keeps its queries and its stream's places across a restart: in <paramref name="Storage"/>,
/// under the keys protocol/specs/src/session/stored.json gives the knowledge base <paramref name="KbId"/>.</summary>
public sealed record CachePersistence(ISessionStorage Storage, string KbId);

/// <summary>What protocol/specs/src/session/stored.json says a client keeps of its queries and its stream.</summary>
internal static class KeptTable
{
    private static readonly JsonElement Stored = JsonSerializer.Deserialize<JsonElement>(ProtocolTables.Stored);
    private static readonly JsonElement Refresh = JsonSerializer.Deserialize<JsonElement>(ProtocolTables.CacheRefresh);
    private static readonly string CachePrefix = Text(Stored.GetProperty("cacheKeyPrefix"), "prefix");
    private static readonly string PlacesPrefix = Text(Stored.GetProperty("lastEventIdKeyPrefix"), "prefix");
    internal static readonly IReadOnlyList<string> Queries = Stored.GetProperty("keptQueries").EnumerateArray().Select(row => Text(row, "query")).ToArray();
    internal static readonly string WholeKey = Text(Stored.GetProperty("wholeKey"), "key");
    internal static readonly long Version = Stored.GetProperty("cacheDocument").GetProperty("properties").GetProperty("version").GetProperty("const").GetInt64();

    internal static string DocumentKey(string kbId, string query) => CachePrefix + kbId + "." + query;
    internal static string PlacesKey(string kbId) => PlacesPrefix + kbId;

    /// <summary>Whether <paramref name="id"/> is a recorded event's id: components/schemas/PersistedEventId.json.</summary>
    internal static bool IsPersistedEventId(JsonElement id) => Required.FaultOf("PersistedEventId", id) is null;

    /// <summary>What client/refresh.json says a query is per: a resource, an annotation, or nothing (null).</summary>
    internal static string? Per(string query)
    {
        var row = Refresh.GetProperty("queries").EnumerateArray().Single(row => Text(row, "name") == query);
        return row.TryGetProperty("per", out var per) ? per.GetString() : null;
    }

    private static string Text(JsonElement row, string name) =>
        row.GetProperty(name).GetString() ?? throw new InvalidOperationException("Missing " + name);
}

/// <summary>How a kept query's key is written in its document, and read back beside its value. Read throws
/// JsonException for a key that is not the query's.</summary>
internal sealed record KeptKey<TKey, T>(string? Per, Func<TKey, string> Write, Func<JsonElement, T, TKey> Read);

internal static class KeptKeys
{
    internal static KeptKey<ResourceId, T> ByResource<T>() =>
        new("resource", id => id.Value, (key, _) => WireJson.Read<ResourceId>(key, JsonSerializerOptions.Default));

    /// <summary>A kept annotation's key is its id alone: its resource is the one it targets.</summary>
    internal static readonly KeptKey<LiveQueries.AnnotationKey, Annotation> ByAnnotation = new("annotation", key => key.Annotation.Value,
        (key, value) => new(AnnotationTools.TargetSource(value.Target), WireJson.Read<AnnotationId>(key, JsonSerializerOptions.Default)));

    internal static KeptKey<bool, T> Whole<T>() => new(null, _ => KeptTable.WholeKey, (key, _) =>
        key.ValueKind == JsonValueKind.String && key.GetString() == KeptTable.WholeKey ? true : throw new JsonException("The key is not the whole key."));
}

internal interface IKeptQuery
{
    public string Name { get; }
    public bool Fetching { get; }

    /// <summary>Its cache has not yet kept what it knows: a fetch is in flight, or a save is owed.</summary>
    public bool Pending { get; }
    public void Owe();
    public void Load();

    /// <summary>Writes the query's document if it owes one, and says whether it did.</summary>
    public bool Save();
    public void Close();
}

/// <summary>One cache document for each kept query, and the places of the stream beside them
/// (protocol/contract/CACHE-SEMANTICS.md B17). <paramref name="refetchOwed"/> says whether the refresher owes a
/// refetch: a B19 window that holds an invalidation it has not yet run.</summary>
internal sealed class LiveCacheStorage(CachePersistence persistence, TimeProvider clock, Func<bool> refetchOwed) : IDisposable
{
    internal static readonly int ByteLimit = ProtocolFacts.Timing("maxStoredBytesCount").GetInt32();
    internal static readonly TimeSpan Debounce = TimeSpan.FromMilliseconds(ProtocolFacts.Timing("saveDebounceMs").GetInt32());
    private readonly object gate = new();
    private readonly Dictionary<string, string> pendingPlaces = new(StringComparer.Ordinal);
    private IReadOnlyDictionary<string, IKeptQuery> kept = new Dictionary<string, IKeptQuery>(StringComparer.Ordinal);
    private bool closed;

    internal TimeProvider Clock => clock;

    /// <summary>What a kept query's cache calls at each change of a value: its save waits for the changes to stop.</summary>
    internal Action Changed(string query) => () => kept[query].Owe();

    internal IKeptQuery Keep<TKey, T>(string query, Cache<TKey, T> cache, KeptKey<TKey, T> key) where TKey : notnull
    {
        if (KeptTable.Per(query) != key.Per) throw new InvalidOperationException(query + " is not keyed by what client/refresh.json says it is per.");
        var kept = new KeptQuery<TKey, T>(this, KeptTable.DocumentKey(persistence.KbId, query), query, cache, key);
        cache.KeptBy(kept);
        return kept;
    }

    /// <summary>Loads each kept query's document, and gives the stream's places that were kept.</summary>
    internal IReadOnlyDictionary<string, string> Start(IKeptQuery[] queries)
    {
        lock (gate)
        {
            kept = queries.ToDictionary(query => query.Name, StringComparer.Ordinal);
            foreach (var query in queries) query.Load();
            return ReadPlaces();
        }
    }

    internal void Apply(ReceivedBusFrame frame, Action apply)
    {
        lock (gate)
        {
            if (closed) return;
            apply();
            // The event's invalidations are under way before its place is noted.
            if (frame.Frame.Scope is ResourceId resource && frame.EventId is { } id && KeptTable.IsPersistedEventId(JsonSerializer.SerializeToElement(id)))
                pendingPlaces[resource.Value] = id;
        }
    }

    internal void Saved(IKeptQuery query)
    {
        lock (gate)
        {
            if (!closed) Write(query);
        }
    }

    /// <summary>Writes the query's document, and the noted places in the same call while no kept query is pending and
    /// the refresher owes no refetch.</summary>
    private void Write(IKeptQuery query)
    {
        if (query.Save() && kept.Values.All(each => !each.Pending) && !refetchOwed()) WritePlaces();
    }

    private void WritePlaces()
    {
        if (pendingPlaces.Count == 0) return;
        var places = ReadPlaces();
        foreach (var (scope, id) in pendingPlaces) places[scope] = id;
        if (Set(KeptTable.PlacesKey(persistence.KbId), JsonSerializer.Serialize(places))) pendingPlaces.Clear();
    }

    private Dictionary<string, string> ReadPlaces()
    {
        var places = new Dictionary<string, string>(StringComparer.Ordinal);
        if (Parse(Get(KeptTable.PlacesKey(persistence.KbId))) is not { ValueKind: JsonValueKind.Object } read) return places;
        foreach (var place in read.EnumerateObject())
            if (ResourceId.TryParse(place.Name, out _) && KeptTable.IsPersistedEventId(place.Value) && place.Value.GetString() is { } id)
                places[place.Name] = id;
        return places;
    }

    /// <summary>The text kept under <paramref name="key"/>. A storage that cannot be read keeps nothing.</summary>
    internal string? Get(string key)
    {
        try { return persistence.Storage.Get(key); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return null; }
    }

    /// <summary>Keeps <paramref name="value"/> under <paramref name="key"/>, and says whether it was kept. A failed write
    /// leaves the live view as it is.</summary>
    internal bool Set(string key, string value)
    {
        try
        {
            persistence.Storage.Set(key, value);
            return true;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return false; }
    }

    internal static JsonElement? Parse(string? text)
    {
        if (text is null) return null;
        try { return JsonSerializer.Deserialize<JsonElement>(text); }
        catch (JsonException) { return null; }
    }

    /// <summary>Flushes what each kept query owes. The gate is read once, first: disposal drops a fetch in flight and a
    /// refetch owed, so either holds the places back, while a save owed is this flush. Apply notes nothing once closed,
    /// so the places written are those noted before the reading.</summary>
    public void Dispose()
    {
        lock (gate)
        {
            if (closed) return;
            closed = true;
            var settled = kept.Values.All(query => !query.Fetching) && !refetchOwed();
            var wrote = false;
            foreach (var query in kept.Values) wrote |= query.Save();
            if (wrote && settled) WritePlaces();
        }
        foreach (var query in kept.Values) query.Close();
    }
}

/// <summary>One kept query's document: its cache's values, each with when it was received, and the wait before the
/// next save.</summary>
internal sealed class KeptQuery<TKey, T> : IKeptQuery where TKey : notnull
{
    private readonly LiveCacheStorage storage;
    private readonly string documentKey;
    private readonly Cache<TKey, T> cache;
    private readonly KeptKey<TKey, T> key;
    private readonly object owing = new();
    private readonly ITimer wait;
    private Dictionary<TKey, Stamp> stamps = [];
    private bool owed;

    internal KeptQuery(LiveCacheStorage storage, string documentKey, string name, Cache<TKey, T> cache, KeptKey<TKey, T> key)
    {
        this.storage = storage;
        this.documentKey = documentKey;
        this.cache = cache;
        this.key = key;
        Name = name;
        wait = storage.Clock.CreateTimer(_ => storage.Saved(this), null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
    }

    public string Name { get; }
    public bool Fetching => cache.Fetching;

    public bool Pending
    {
        get
        {
            lock (owing) if (owed) return true;
            return Fetching;
        }
    }

    public void Owe()
    {
        lock (owing)
        {
            owed = true;
            wait.Change(LiveCacheStorage.Debounce, Timeout.InfiniteTimeSpan);
        }
    }

    public void Load()
    {
        if (Entries(storage.Get(documentKey)) is not { } entries) return;
        foreach (var (stored, kept, at) in entries)
        {
            try
            {
                var value = WireJson.Read<T>(kept, JsonSerializerOptions.Default);
                var id = key.Read(stored, value);
                cache.Entry(id).Rehydrate(value);
                stamps[id] = new Stamp(JsonSerializer.Serialize(value), at);
            }
            catch (JsonException) { /* An entry whose key or value is not the query's is skipped. */ }
        }
    }

    /// <summary>The entries of a document whose structure is stored.json's `cacheDocument`, each a key, a value and a
    /// stamp; null for any other. A number is read by its value, however it is written.</summary>
    private static List<(JsonElement Key, JsonElement Value, long At)>? Entries(string? text)
    {
        if (LiveCacheStorage.Parse(text) is not { ValueKind: JsonValueKind.Object } document ||
            !document.TryGetProperty("version", out var version) || version.ValueKind != JsonValueKind.Number ||
            Required.NumberOf(version) != KeptTable.Version ||
            !document.TryGetProperty("entries", out var listed) || listed.ValueKind != JsonValueKind.Array)
            return null;
        var entries = new List<(JsonElement, JsonElement, long)>();
        foreach (var entry in listed.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Array || entry.GetArrayLength() != 3 || StampOf(entry[2]) is not { } at) return null;
            entries.Add((entry[0], entry[1], at));
        }
        return entries;
    }

    /// <summary>An integer of at least 0, which a stamp is; null for anything else, and for one too great to hold.</summary>
    private static long? StampOf(JsonElement value)
    {
        if (!Required.IsInteger(value)) return null;
        var at = Required.NumberOf(value);
        return at is >= 0 and < long.MaxValue ? (long)at : null;
    }

    public bool Save()
    {
        lock (owing)
        {
            if (!owed) return false;
            owed = false;
        }
        var now = storage.Clock.GetUtcNow().ToUnixTimeMilliseconds();
        var held = new List<(TKey Id, Stamp Stamp)>();
        foreach (var (id, query) in cache.Snapshot())
        {
            if (query.CurrentValue is not { } ready) continue;
            var text = JsonSerializer.Serialize(ready.Value);
            held.Add((id, stamps.TryGetValue(id, out var prior) && prior.Text == text ? prior : new Stamp(text, now)));
        }
        var oldestFirst = held.OrderBy(entry => entry.Stamp.At).ToArray();
        var fitting = oldestFirst[Evicted(oldestFirst)..];
        if (!storage.Set(documentKey, Encoding.UTF8.GetString(Encode(fitting)))) return false;
        stamps = fitting.ToDictionary(entry => entry.Id, entry => entry.Stamp);
        return true;
    }

    /// <summary>How many of the oldest entries must go for the document to fit in maxStoredBytesCount.</summary>
    private int Evicted((TKey Id, Stamp Stamp)[] oldestFirst)
    {
        var low = 0;
        var high = oldestFirst.Length;
        while (low < high)
        {
            var middle = low + (high - low) / 2;
            if (Encode(oldestFirst[middle..]).Length > LiveCacheStorage.ByteLimit) low = middle + 1;
            else high = middle;
        }
        return low;
    }

    private byte[] Encode((TKey Id, Stamp Stamp)[] entries)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteNumber("version", KeptTable.Version);
            writer.WriteStartArray("entries");
            foreach (var (id, stamp) in entries)
            {
                writer.WriteStartArray();
                writer.WriteStringValue(key.Write(id));
                writer.WriteRawValue(stamp.Text);
                writer.WriteNumberValue(stamp.At);
                writer.WriteEndArray();
            }
            writer.WriteEndArray();
            writer.WriteEndObject();
        }
        return buffer.ToArray();
    }

    public void Close() => wait.Dispose();

    /// <summary>A kept value's JSON text, and when it was received, in milliseconds since the Unix epoch.</summary>
    private sealed record Stamp(string Text, long At);
}
