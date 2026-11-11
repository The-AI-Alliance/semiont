using System.Text;
using System.Text.Json;
using Semiont.Annotations;
using Semiont.Errors;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.Registry;
using Semiont.Serialization;
using Semiont.SignIn;
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
    private readonly WritesWhileNamed? session;
    private string? personKey;
    private LiveCacheStorage? started;

    /// <summary>
    /// Keeps what a client holds in the knowledge base <paramref name="kbId"/> for the person whose key is
    /// <paramref name="personKey"/> (<see cref="RegistryStorage.PersonKey"/> of their did), read as the client is made.
    /// It writes whatever sign-in is kept; a session that keeps only while its sign-in names the person is one
    /// <see cref="Registry.HttpSessionFactory"/> opens, or <see cref="Session.SemiontSession.FromKeptAsync"/> makes.
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

    /// <summary>
    /// A session's that its SDK builds: it keeps nothing until the gateway names the person, writes only while
    /// <paramref name="kept"/>, what holds the session's sign-in, still names them, and tells
    /// <paramref name="sessionErrors"/>, the session's errors stream, once when it cannot read that sign-in or record the
    /// person on it, and each time the storage refuses a write.
    /// </summary>
    internal CachePersistence(ISessionStorage storage, string kbId, ISignInKept kept, Action<SessionError> sessionErrors)
    {
        ArgumentNullException.ThrowIfNull(storage);
        Storage = storage;
        KbId = kbId;
        session = new WritesWhileNamed(kept, kbId, sessionErrors);
        Writer = session;
    }

    internal ISessionStorage Storage { get; }
    internal string KbId { get; }
    internal ICacheWriter Writer { get; }

    /// <summary>
    /// Records on the session's sign-in that <paramref name="token"/> is <paramref name="user"/>'s, and keeps for them once
    /// it is recorded. A sign-in that cannot record them ends this keeping.
    /// </summary>
    internal async Task RecordAsync(string token, UserResponse user, CancellationToken cancellation)
    {
        var recording = session ?? throw new InvalidOperationException("Only a session's persistence records whom its sign-in names.");
        var person = RegistryStorage.PersonKey(user.Did);
        if (await recording.RecordsAsync(token, person, cancellation).ConfigureAwait(false)) Attach(person);
    }

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
    /// saves are written under: a save already writing lands before the delete, and none follows it.
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
/// Whether a client's persistence writes what it keeps for a person, asked before each write; once it answers no, the
/// client writes nothing more. It also says which of the storage's failures are refusals of a write, which leave the
/// write's save owed.
/// </summary>
internal interface ICacheWriter
{
    public ValueTask<bool> WritesAsync(string personKey);

    /// <summary>Whether <paramref name="error"/>, which the storage threw at a write, is its refusal of that write, said
    /// where this persistence says its refusals.</summary>
    public bool Refused(Exception error);
}

/// <summary>A persistence given its person: it writes whatever sign-in is kept, and has no session to say a refusal
/// to.</summary>
internal sealed class WritesAsGiven : ICacheWriter
{
    public ValueTask<bool> WritesAsync(string personKey) => ValueTask.FromResult(true);
    public bool Refused(Exception error) => error is IOException or UnauthorizedAccessException;
}

/// <summary>
/// A session's: it writes only while what holds its sign-in, <paramref name="kept"/>, names the person. A sign-in it
/// cannot read, or cannot record the person on, is not known to name them: the keeping ends, and the session is told why
/// through <paramref name="sessionErrors"/>, once. Whatever the storage throws at a write is its refusal, said there each
/// time.
/// </summary>
internal sealed class WritesWhileNamed(ISignInKept kept, string kbId, Action<SessionError> sessionErrors) : ICacheWriter
{
    private int ended;

    public async ValueTask<bool> WritesAsync(string personKey)
    {
        if (Volatile.Read(ref ended) != 0) return false;
        try { return await kept.HeldAsync().ConfigureAwait(false) is { } held && held.PersonKey == personKey; }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            End("could not be read before its client saved", error);
            return false;
        }
    }

    /// <summary>Records on the sign-in that <paramref name="token"/> is the person whose key is
    /// <paramref name="personKey"/>, and says whether the client keeps for them.</summary>
    internal async Task<bool> RecordsAsync(string token, string personKey, CancellationToken cancellation)
    {
        if (Volatile.Read(ref ended) != 0) return false;
        try { return await kept.RecordPersonKeyAsync(token, personKey, cancellation).ConfigureAwait(false); }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            End("could not record the person the gateway named", error);
            return false;
        }
    }

    public bool Refused(Exception error)
    {
        sessionErrors(new SessionError(ProtocolFacts.SessionError("save-refused"),
            "The storage refused a write of what the client keeps for knowledge base " + kbId + ": " + error.Message, error));
        return true;
    }

    private void End(string why, Exception error)
    {
        if (Interlocked.Exchange(ref ended, 1) == 0)
            sessionErrors(new SessionError(ProtocolFacts.SessionError("keep-failed"),
                "The sign-in kept for knowledge base " + kbId + " " + why + ", so the client keeps nothing more.", error));
    }
}

/// <summary>What protocol/specs/src/session/stored.json says a kept query's document is.</summary>
internal static class KeptTable
{
    private static readonly JsonElement Stored = JsonSerializer.Deserialize<JsonElement>(ProtocolTables.Stored);
    private static readonly JsonElement Refresh = JsonSerializer.Deserialize<JsonElement>(ProtocolTables.CacheRefresh);
    internal static readonly string WholeKey = Text(Stored.GetProperty("wholeKey"), "key");
    internal static readonly long Version = Stored.GetProperty("cacheDocument").GetProperty("properties").GetProperty("version").GetProperty("const").GetInt64();

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

    /// <summary>Drops the save owed: what was not written never is.</summary>
    public void Discard();

    /// <summary>Reads the document under <paramref name="documentKey"/> into the keys its cache does not hold.</summary>
    public void Load(string documentKey);

    /// <summary>The document the save owed writes, its stamps taken as of now; null when no save is owed.</summary>
    public string? Take();

    /// <summary>Writes <paramref name="document"/> under <paramref name="documentKey"/>, and says whether the storage
    /// kept it. A write it refuses leaves the save owed.</summary>
    public bool Put(string documentKey, string document);
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
    private readonly TaskCompletionSource flushed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private IReadOnlyDictionary<string, IKeptQuery> kept = new Dictionary<string, IKeptQuery>(StringComparer.Ordinal);
    private Action<IReadOnlyDictionary<string, string>>? placesKept;
    private string? person;
    private bool abandoned;
    private bool closed;

    internal TimeProvider Clock => clock;

    /// <summary>Complete once disposal's flush has written what it could, at once when nothing was owed, whoever disposed
    /// it first.</summary>
    internal Task Flushed => flushed.Task;

    /// <summary>What a kept query's cache calls at each change of a value: its save waits for the changes to stop. Nothing
    /// is owed before the person is named: what a cache holds then is written with its next change.</summary>
    internal Action Changed(string query) => () =>
    {
        if (Volatile.Read(ref person) is not null) kept[query].Owe();
    };

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
    /// them, and saves for them from each change on. Attaching writes nothing.
    /// </summary>
    internal void Attach(string named)
    {
        lock (gate)
        {
            if (closed || abandoned || person is not null) return;
            var restoring = placesKept ?? throw new InvalidOperationException("The persistence keeps for a person before it has started.");
            Volatile.Write(ref person, named);
            foreach (var query in kept.Values) query.Load(DocumentKey(named, query));
            restoring(ReadPlaces(named));
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

    internal void Apply(Carried carried, Action apply)
    {
        lock (gate)
        {
            if (closed) return;
            apply();
            // A refused frame is no position on its scope, and the event's invalidations are under way before its
            // place is noted.
            if (person is not null && !abandoned && carried is ReceivedBusFrame { Frame.Scope: ResourceId resource } frame &&
                frame.EventId is { } id && Required.IsPersistedEventId(JsonSerializer.SerializeToElement(id)))
                pendingPlaces[resource.Value] = id;
        }
    }

    /// <summary>What a kept query's wait calls once it has passed.</summary>
    internal void Saved(IKeptQuery query) => _ = SaveAsync(query);

    /// <summary>Writes the query's document, and the noted places in the same call while no kept query is pending and
    /// the refresher owes no refetch: only while the persistence writes for its person, asked first. Once it does not,
    /// nothing more is written.</summary>
    private async Task SaveAsync(IKeptQuery query)
    {
        string named;
        lock (gate)
        {
            if (closed || person is not { } keptFor) return;
            if (abandoned)
            {
                query.Discard();
                return;
            }
            named = keptFor;
        }
        var writes = await persistence.Writer.WritesAsync(named).ConfigureAwait(false);
        lock (gate)
        {
            // A disposal meanwhile flushes the save this one owes.
            if (closed) return;
            if (abandoned || !writes)
            {
                Abandon();
                return;
            }
            if (query.Take() is { } document && query.Put(DocumentKey(named, query), document) &&
                kept.Values.All(each => !each.Pending) && !refetchOwed())
                WritePlaces(named);
        }
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
            if (ResourceId.TryParse(place.Name, out _) && Required.IsPersistedEventId(place.Value) && place.Value.GetString() is { } id)
                places[place.Name] = id;
        return places;
    }

    /// <summary>The text kept under <paramref name="key"/>. A storage that cannot be read keeps nothing.</summary>
    internal string? Get(string key)
    {
        try { return persistence.Storage.Get(key); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return null; }
    }

    /// <summary>Keeps <paramref name="value"/> under <paramref name="key"/>, and says whether it was kept. A write the
    /// storage refuses leaves the live view as it is, and is said where the persistence says its refusals.</summary>
    internal bool Set(string key, string value)
    {
        try
        {
            persistence.Storage.Set(key, value);
            return true;
        }
        catch (Exception error)
        {
            if (!persistence.Writer.Refused(error)) throw;
            return false;
        }
    }

    internal static JsonElement? Parse(string? text)
    {
        if (text is null) return null;
        try { return JsonSerializer.Deserialize<JsonElement>(text); }
        catch (JsonException) { return null; }
    }

    /// <summary>Flushes what each kept query owes. The gate is read once, first: disposal drops a fetch in flight and a
    /// refetch owed, so either holds the places back, while a save owed is this flush. Apply notes nothing once closed,
    /// so the places written are those noted before the reading. The documents are taken before the caches close, and
    /// written once the persistence says it writes for the person: before this returns, unless asking waits on what
    /// holds the sign-in. <see cref="Flushed"/> completes once they are written.</summary>
    public void Dispose()
    {
        string? named;
        bool settled;
        var owed = new List<(IKeptQuery Query, string Document)>();
        lock (gate)
        {
            if (closed) return;
            closed = true;
            settled = kept.Values.All(query => !query.Fetching) && !refetchOwed();
            named = abandoned ? null : person;
            if (named is not null)
                foreach (var query in kept.Values)
                    if (query.Take() is { } document) owed.Add((query, document));
        }
        foreach (var query in kept.Values) query.Close();
        if (named is not null && owed.Count > 0) _ = FlushAsync(named, owed, settled);
        else flushed.SetResult();
    }

    private async Task FlushAsync(string named, List<(IKeptQuery Query, string Document)> owed, bool settled)
    {
        try
        {
            if (await persistence.Writer.WritesAsync(named).ConfigureAwait(false))
                lock (gate)
                {
                    if (!abandoned)
                    {
                        var wrote = false;
                        foreach (var (query, document) in owed) wrote |= query.Put(DocumentKey(named, query), document);
                        if (wrote && settled) WritePlaces(named);
                    }
                }
            flushed.SetResult();
        }
        catch (Exception error) { flushed.SetException(error); }
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

    public string? Take()
    {
        lock (owing)
        {
            if (!owed) return null;
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
        // A value's stamp is when it was received, whether or not the storage keeps this write.
        stamps = fitting.ToDictionary(entry => entry.Id, entry => entry.Stamp);
        return Encoding.UTF8.GetString(Encode(fitting));
    }

    public bool Put(string documentKey, string document)
    {
        if (storage.Set(documentKey, document)) return true;
        // A refused write keeps its save owed, with no wait of its own: the next change, or disposal's flush, writes it
        // again, and the places wait for it.
        lock (owing) owed = true;
        return false;
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
