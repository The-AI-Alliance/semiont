using System.Text;
using System.Text.Json;
using Semiont.Annotations;
using Semiont.Errors;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.Registry;
using Semiont.Serialization;
using Semiont.Storage;
using Semiont.Types;

namespace Semiont;

/// <summary>
/// Where a client keeps what it holds for one person of one knowledge base: a session storage, with one document,
/// kept within a size, for each query protocol/specs/src/client/refresh.json marks persisted, and the stream's places
/// beside them.
/// </summary>
public sealed class CachePersistence
{
    private readonly object gate = new();
    private string? personKey;
    private LiveCacheStorage? started;

    /// <summary>
    /// Keeps what a client holds in the knowledge base <paramref name="kbId"/> for the person whose key is
    /// <paramref name="personKey"/> (<see cref="RegistryStorage.PersonKey"/> of their did), read as the client is made.
    /// It writes whatever sign-in is kept; a session that keeps only while the knowledge base's saved sign-in names the
    /// person, and whose forgetting leaves nothing written after, is one <see cref="Registry.HttpSessionFactory"/> opens.
    /// </summary>
    public CachePersistence(ISessionStorage storage, string kbId, string personKey)
    {
        ArgumentNullException.ThrowIfNull(storage);
        ArgumentException.ThrowIfNullOrEmpty(personKey);
        Storage = storage;
        KbId = kbId;
        Writer = new WritesAsGiven();
        this.personKey = personKey;
    }

    private CachePersistence(ISessionStorage storage, string kbId, Action<SessionError> sessionErrors)
    {
        ArgumentNullException.ThrowIfNull(storage);
        Storage = storage;
        KbId = kbId;
        Writer = new WritesWhileNamed(storage, kbId, sessionErrors);
    }

    /// <summary>
    /// A registry session's: it keeps nothing until the knowledge base's sign-in records its person, writes only while
    /// the sign-in stored beside it still names them, and tells <paramref name="sessionErrors"/>, the session's error
    /// channel, when it cannot read that sign-in.
    /// </summary>
    internal static CachePersistence ForSignIn(ISessionStorage storage, string kbId, Action<SessionError> sessionErrors) =>
        new(storage, kbId, sessionErrors);

    internal ISessionStorage Storage { get; }
    internal string KbId { get; }
    internal ICacheWriter Writer { get; }

    /// <summary>Begins keeping for <paramref name="person"/>, unless a person is already kept for.</summary>
    internal void Attach(string person)
    {
        LiveCacheStorage? live;
        lock (gate)
        {
            if (personKey is not null) return;
            personKey = person;
            live = started;
        }
        live?.Attach(person);
    }

    internal string? Started(LiveCacheStorage live)
    {
        lock (gate)
        {
            started = live;
            return personKey;
        }
    }

    /// <summary>
    /// Forgets the knowledge base's saved sign-in, and what is kept for the person it names, under the lock the client's
    /// saves are checked and written under: a save already past the check lands before the delete, and none follows it.
    /// </summary>
    internal void Forget()
    {
        LiveCacheStorage? live;
        lock (gate)
        {
            live = started;
            // A client not yet started has no save to wait for, and starts only once the sign-in is forgotten.
            if (live is null)
            {
                RegistryStorage.ClearStoredSession(Storage, KbId);
                return;
            }
        }
        live.Forget(() => RegistryStorage.ClearStoredSession(Storage, KbId));
    }
}

/// <summary>
/// Whether a client's persistence writes what it keeps for a person, asked under the lock its saves are written under,
/// before each write; once it answers no, the client writes nothing more.
/// </summary>
internal interface ICacheWriter
{
    public bool Writes(string personKey);
}

/// <summary>A persistence given its person: it writes whatever sign-in is kept.</summary>
internal sealed class WritesAsGiven : ICacheWriter
{
    public bool Writes(string personKey) => true;
}

/// <summary>
/// A registry session's: it writes only while the sign-in stored beside it names the person. A stored sign-in it cannot
/// read is not known to name them, and the session is told why through <paramref name="sessionErrors"/>.
/// </summary>
internal sealed class WritesWhileNamed(ISessionStorage storage, string kbId, Action<SessionError> sessionErrors) : ICacheWriter
{
    public bool Writes(string personKey)
    {
        try { return RegistryStorage.StoredSession(storage, kbId) is { } stored && stored.PersonKey == personKey; }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            sessionErrors(new SessionError(ProtocolFacts.SessionError("keep-failed"),
                "The sign-in saved for knowledge base " + kbId + " could not be read before its client saved, so the client keeps nothing more.",
                error));
            return false;
        }
    }
}

/// <summary>What protocol/specs/src/session/stored.json says a kept query's document is.</summary>
internal static class KeptTable
{
    private static readonly JsonElement Stored = JsonSerializer.Deserialize<JsonElement>(ProtocolTables.Stored);
    private static readonly JsonElement Refresh = JsonSerializer.Deserialize<JsonElement>(ProtocolTables.CacheRefresh);
    internal static readonly string WholeKey = Text(Stored.GetProperty("wholeKey"), "key");
    internal static readonly long Version = Stored.GetProperty("cacheDocument").GetProperty("properties").GetProperty("version").GetProperty("const").GetInt64();

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

    /// <summary>A save is owed: a value changed and has not been written since.</summary>
    public bool Owed { get; }
    public void Owe();

    /// <summary>Begins the wait before the next save again, if a save is owed.</summary>
    public void Resume();

    /// <summary>Drops the save owed: what was not written never is.</summary>
    public void Discard();

    /// <summary>Reads the document under <paramref name="documentKey"/> into the keys its cache does not hold.</summary>
    public void Load(string documentKey);

    /// <summary>Writes the query's document under <paramref name="documentKey"/> if it owes one, and says whether it
    /// did.</summary>
    public bool Save(string documentKey);
    public void Close();
}

/// <summary>One cache document for each kept query, and the places of the stream beside them, kept for the person of
/// <paramref name="persistence"/> (protocol/contract/CACHE-SEMANTICS.md B17). <paramref name="refetchOwed"/> says
/// whether the refresher owes a refetch: a B19 window that holds an invalidation it has not yet run.</summary>
internal sealed class LiveCacheStorage(CachePersistence persistence, TimeProvider clock, Func<bool> refetchOwed) : IDisposable
{
    internal static readonly int ByteLimit = ProtocolFacts.Timing("maxStoredBytesCount").GetInt32();
    internal static readonly TimeSpan Debounce = TimeSpan.FromMilliseconds(ProtocolFacts.Timing("saveDebounceMs").GetInt32());
    private readonly object gate = new();
    private readonly Dictionary<string, string> pendingPlaces = new(StringComparer.Ordinal);
    private IReadOnlyDictionary<string, IKeptQuery> kept = new Dictionary<string, IKeptQuery>(StringComparer.Ordinal);
    private Action<IReadOnlyDictionary<string, string>>? placesKept;
    private string? person;
    private bool abandoned;
    private bool closed;

    internal TimeProvider Clock => clock;

    /// <summary>What a kept query's cache calls at each change of a value: its save waits for the changes to stop.</summary>
    internal Action Changed(string query) => () => kept[query].Owe();

    internal IKeptQuery Keep<TKey, T>(string query, Cache<TKey, T> cache, KeptKey<TKey, T> key) where TKey : notnull
    {
        if (KeptTable.Per(query) != key.Per) throw new InvalidOperationException(query + " is not keyed by what client/refresh.json says it is per.");
        var kept = new KeptQuery<TKey, T>(this, query, cache, key);
        cache.KeptBy(kept);
        return kept;
    }

    /// <summary>
    /// Keeps <paramref name="queries"/>, for the persistence's person from when it has one. <paramref name="placesKept"/>
    /// is given the stream's places kept for that person.
    /// </summary>
    internal void Start(IKeptQuery[] queries, Action<IReadOnlyDictionary<string, string>> placesKept)
    {
        lock (gate)
        {
            kept = queries.ToDictionary(query => query.Name, StringComparer.Ordinal);
            this.placesKept = placesKept;
        }
        if (persistence.Started(this) is { } named) Attach(named);
    }

    /// <summary>
    /// Reads what is kept for <paramref name="named"/> into the keys no cache holds, gives the stream's places kept for
    /// them, and saves for them from then on, beginning with what the caches came to owe before.
    /// </summary>
    internal void Attach(string named)
    {
        lock (gate)
        {
            if (closed || abandoned || person is not null) return;
            var restoring = placesKept ?? throw new InvalidOperationException("The persistence keeps for a person before it has started.");
            person = named;
            foreach (var query in kept.Values) query.Load(DocumentKey(named, query));
            restoring(ReadPlaces(named));
            foreach (var query in kept.Values) query.Resume();
        }
    }

    /// <summary>Runs <paramref name="forget"/> once no save is being written, and writes nothing after it.</summary>
    internal void Forget(Action forget)
    {
        lock (gate)
        {
            Abandon();
            forget();
        }
    }

    internal void Apply(ReceivedBusFrame frame, Action apply)
    {
        lock (gate)
        {
            if (closed) return;
            apply();
            // The event's invalidations are under way before its place is noted.
            if (person is not null && !abandoned && frame.Frame.Scope is ResourceId resource && frame.EventId is { } id &&
                KeptTable.IsPersistedEventId(JsonSerializer.SerializeToElement(id)))
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
    /// the refresher owes no refetch: once a person is kept for, and only while the persistence writes for them. A save
    /// owed before the person is known waits for them.</summary>
    private void Write(IKeptQuery query)
    {
        if (person is not { } named) return;
        if (abandoned || !Writes(named)) query.Discard();
        else if (query.Save(DocumentKey(named, query)) && kept.Values.All(each => !each.Pending) && !refetchOwed()) WritePlaces(named);
    }

    /// <summary>Whether the persistence still writes for <paramref name="named"/>; once it does not, nothing more is.</summary>
    private bool Writes(string named)
    {
        if (persistence.Writer.Writes(named)) return true;
        Abandon();
        return false;
    }

    private void Abandon()
    {
        abandoned = true;
        pendingPlaces.Clear();
        foreach (var query in kept.Values) query.Discard();
    }

    private string DocumentKey(string named, IKeptQuery query) => RegistryStorage.CacheKey(persistence.KbId, named, query.Name);

    private void WritePlaces(string named)
    {
        if (pendingPlaces.Count == 0) return;
        var places = ReadPlaces(named);
        foreach (var (scope, id) in pendingPlaces) places[scope] = id;
        if (Set(RegistryStorage.LastEventIdKey(persistence.KbId, named), JsonSerializer.Serialize(places))) pendingPlaces.Clear();
    }

    private Dictionary<string, string> ReadPlaces(string named)
    {
        var places = new Dictionary<string, string>(StringComparer.Ordinal);
        if (Parse(Get(RegistryStorage.LastEventIdKey(persistence.KbId, named))) is not { ValueKind: JsonValueKind.Object } read) return places;
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
            if (person is { } named && !abandoned && kept.Values.Any(query => query.Owed) && Writes(named))
            {
                var wrote = false;
                foreach (var query in kept.Values) wrote |= query.Save(DocumentKey(named, query));
                if (wrote && settled) WritePlaces(named);
            }
        }
        foreach (var query in kept.Values) query.Close();
    }
}

/// <summary>One kept query's document: its cache's values, each with when it was received, and the wait before the
/// next save.</summary>
internal sealed class KeptQuery<TKey, T> : IKeptQuery where TKey : notnull
{
    private readonly LiveCacheStorage storage;
    private readonly Cache<TKey, T> cache;
    private readonly KeptKey<TKey, T> key;
    private readonly object owing = new();
    private Dictionary<TKey, Stamp> stamps = [];
    private ITimer? wait;
    private bool owed;
    private bool closed;

    internal KeptQuery(LiveCacheStorage storage, string name, Cache<TKey, T> cache, KeptKey<TKey, T> key)
    {
        this.storage = storage;
        this.cache = cache;
        this.key = key;
        Name = name;
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

    public bool Owed { get { lock (owing) return owed; } }

    public void Owe()
    {
        lock (owing)
        {
            owed = true;
            Wait();
        }
    }

    public void Resume()
    {
        lock (owing) if (owed) Wait();
    }

    public void Discard()
    {
        lock (owing)
        {
            owed = false;
            wait?.Dispose();
            wait = null;
        }
    }

    // The wait starts again at each change, so a burst of changes is one save.
    private void Wait()
    {
        if (closed) return;
        wait?.Dispose();
        wait = storage.Clock.CreateTimer(_ => storage.Saved(this), null, LiveCacheStorage.Debounce, Timeout.InfiniteTimeSpan);
    }

    public void Load(string documentKey)
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

    public bool Save(string documentKey)
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
        if (!storage.Set(documentKey, Encoding.UTF8.GetString(Encode(fitting))))
        {
            // A failed write keeps its value owed: the next save writes it, and the places wait for it.
            lock (owing) owed = true;
            return false;
        }
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

    public void Close()
    {
        lock (owing)
        {
            closed = true;
            wait?.Dispose();
            wait = null;
        }
    }

    /// <summary>A kept value's JSON text, and when it was received, in milliseconds since the Unix epoch.</summary>
    private sealed record Stamp(string Text, long At);
}
