using System.Buffers;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.Registry;
using Semiont.Storage;

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
        this.personKey = personKey;
    }

    private CachePersistence(ISessionStorage storage, string kbId)
    {
        ArgumentNullException.ThrowIfNull(storage);
        Storage = storage;
        KbId = kbId;
        FollowsSignIn = true;
    }

    /// <summary>
    /// A registry session's: it keeps nothing until the knowledge base's sign-in records its person, and writes only
    /// while the sign-in stored beside it still names them.
    /// </summary>
    internal static CachePersistence ForSignIn(ISessionStorage storage, string kbId) => new(storage, kbId);

    internal ISessionStorage Storage { get; }
    internal string KbId { get; }
    internal bool FollowsSignIn { get; }

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
        live?.Keep(person);
    }

    internal string? Started(LiveCacheStorage live)
    {
        lock (gate)
        {
            started = live;
            return personKey;
        }
    }
}

internal sealed record SavedCacheValue(JsonElement Key, JsonElement Value);

internal interface ISavedCache
{
    public string Name { get; }
    public long Revision { get; }
    public bool Collect(List<SavedCacheValue> values, bool requireIdle);
    public void Rehydrate(SavedCacheValue value);
}

internal sealed class LiveCacheStorage(CachePersistence persistence, TimeProvider clock) : IDisposable
{
    private const int Version = 1;
    private static readonly int ByteLimit = ProtocolFacts.Timing("maxStoredBytesCount").GetInt32();
    private static readonly TimeSpan Debounce = TimeSpan.FromMilliseconds(ProtocolFacts.Timing("saveDebounceMs").GetInt32());
    private readonly object gate = new();
    private readonly Channel<bool> saves = Channel.CreateBounded<bool>(1);
    private readonly CancellationTokenSource lifetime = new();
    private readonly Dictionary<string, string> pendingPlaces = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> savedRevisions = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Dictionary<string, Stamp>> stamps = new(StringComparer.Ordinal);
    private ISavedCache[] caches = [];
    private HttpTransport? transport;
    private string? person;
    private bool abandoned;
    private int dirty;
    private volatile bool saving;
    internal bool Pending => saving || Volatile.Read(ref dirty) != 0;
    private bool closed;

    internal void Start(HttpTransport client, ISavedCache[] persisted)
    {
        lock (gate)
        {
            transport = client;
            caches = persisted;
            foreach (var cache in caches)
            {
                savedRevisions[cache.Name] = 0;
                stamps[cache.Name] = new(StringComparer.Ordinal);
            }
        }
        if (persistence.Started(this) is { } kept) Keep(kept);
        _ = SaveWhenQuietAsync(lifetime.Token);
    }

    /// <summary>
    /// Reads what is kept for <paramref name="kept"/> into the keys no cache holds, gives the transport the places of
    /// the scopes it holds none for, and saves for them from then on, beginning with what the caches came to hold before.
    /// </summary>
    internal void Keep(string kept)
    {
        lock (gate)
        {
            if (closed || abandoned || person is not null) return;
            var restoring = transport ?? throw new InvalidOperationException("The persistence keeps for a person before it has started.");
            person = kept;
            foreach (var cache in caches)
                foreach (var (value, writtenAt) in Entries(Read(RegistryStorage.CacheKey(persistence.KbId, kept, cache.Name))))
                {
                    cache.Rehydrate(value);
                    stamps[cache.Name][Json(value.Key)] = new Stamp(Json(value.Value), writtenAt);
                }
            restoring.RestoreWatermarks(Places(kept));
            if (caches.Any(cache => cache.Revision != savedRevisions[cache.Name])) Changed();
        }
    }

    internal void Changed()
    {
        Interlocked.Exchange(ref dirty, 1);
        saves.Writer.TryWrite(true);
    }

    internal void Apply(ReceivedBusFrame frame, Action apply)
    {
        lock (gate)
        {
            if (closed) return;
            apply();
            if (person is not null && !abandoned && frame.Frame.Scope is ResourceId resource && IsPlace(frame.EventId))
            {
                // The event's invalidations are in flight before its place can be saved.
                pendingPlaces[resource.Value] = frame.EventId;
                Changed();
            }
        }
    }

    private static bool IsPlace([System.Diagnostics.CodeAnalysis.NotNullWhen(true)] string? id) =>
        id is not null && id.StartsWith("p-", StringComparison.Ordinal);

    private string? Read(string key)
    {
        try { return persistence.Storage.Get(key); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return null; }
    }

    private static List<(SavedCacheValue Value, long WrittenAt)> Entries(string? text)
    {
        var values = new List<(SavedCacheValue Value, long WrittenAt)>();
        if (RegistryStorage.Read<Document>(text) is not { Version: Version, Entries.ValueKind: JsonValueKind.Array } document) return values;
        foreach (var entry in document.Entries.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Array || entry.GetArrayLength() != 3 ||
                entry[2].ValueKind != JsonValueKind.Number || !entry[2].TryGetInt64(out var written)) return [];
            values.Add((new SavedCacheValue(entry[0], entry[1]), written));
        }
        return values;
    }

    private Dictionary<string, string> Places(string kept)
    {
        var places = new Dictionary<string, string>(StringComparer.Ordinal);
        if (RegistryStorage.Read<Dictionary<string, JsonElement>>(Read(RegistryStorage.LastEventIdKey(persistence.KbId, kept))) is not { } stored)
            return places;
        foreach (var (scope, id) in stored)
            if (ResourceId.TryParse(scope, out _) && id.ValueKind == JsonValueKind.String && id.GetString() is { } place && IsPlace(place))
                places.Add(scope, place);
        return places;
    }

    private async Task SaveWhenQuietAsync(CancellationToken cancellation)
    {
        try
        {
            await foreach (var _ in saves.Reader.ReadAllAsync(cancellation).ConfigureAwait(false))
            {
                await Task.Delay(Debounce, clock, cancellation).ConfigureAwait(false);
                lock (gate)
                {
                    if (closed) return;
                    if (!Flush(force: false)) saves.Writer.TryWrite(true);
                }
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
    }

    private bool Flush(bool force)
    {
        saving = true;
        try { return Write(force); }
        finally { saving = false; }
    }

    private bool Write(bool force)
    {
        if (Interlocked.Exchange(ref dirty, 0) == 0 || person is not { } kept || abandoned) return true;
        var revisions = caches.Select(cache => cache.Revision).ToArray();
        var documents = caches.Select(_ => new List<SavedCacheValue>()).ToArray();
        var idle = Collect(documents, requireIdle: true);
        if (!idle)
        {
            if (!force)
            {
                Interlocked.Exchange(ref dirty, 1);
                return false;
            }
            foreach (var document in documents) document.Clear();
            Collect(documents, requireIdle: false);
        }

        try
        {
            if (persistence.FollowsSignIn && !SignInNames(kept))
            {
                abandoned = true;
                pendingPlaces.Clear();
                return true;
            }
            var now = clock.GetUtcNow().ToUnixTimeMilliseconds();
            var wrote = false;
            for (var index = 0; index < caches.Length; index++)
            {
                var name = caches[index].Name;
                if (revisions[index] == savedRevisions[name]) continue;
                var written = Stamped(stamps[name], documents[index], now);
                persistence.Storage.Set(RegistryStorage.CacheKey(persistence.KbId, kept, name), Encoding.UTF8.GetString(Bounded(written, now)));
                stamps[name] = written;
                savedRevisions[name] = revisions[index];
                wrote = true;
            }
            if (wrote && idle && pendingPlaces.Count > 0)
            {
                var places = Places(kept);
                foreach (var (scope, id) in pendingPlaces) places[scope] = id;
                persistence.Storage.Set(RegistryStorage.LastEventIdKey(persistence.KbId, kept), JsonSerializer.Serialize(places));
                pendingPlaces.Clear();
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // The next write can try again. Failed persistence does not affect the live view.
        }
        return true;
    }

    private bool Collect(List<SavedCacheValue>[] documents, bool requireIdle)
    {
        for (var index = 0; index < caches.Length; index++)
            if (!caches[index].Collect(documents[index], requireIdle)) return false;
        return true;
    }

    private bool SignInNames(string kept) =>
        RegistryStorage.StoredSession(persistence.Storage, persistence.KbId) is { } stored && stored.PersonKey == kept;

    // An entry keeps when it was written while its value is unchanged, so eviction drops the entries longest without a new one.
    private static Dictionary<string, Stamp> Stamped(Dictionary<string, Stamp> prior, List<SavedCacheValue> values, long now)
    {
        var stamped = new Dictionary<string, Stamp>(StringComparer.Ordinal);
        foreach (var value in values)
        {
            var key = Json(value.Key);
            var text = Json(value.Value);
            stamped[key] = new Stamp(text, prior.TryGetValue(key, out var stamp) && stamp.Value == text ? stamp.WrittenAt : now);
        }
        return stamped;
    }

    private static byte[] Bounded(Dictionary<string, Stamp> stamped, long now)
    {
        var entries = stamped.OrderBy(pair => pair.Value.WrittenAt).Select(pair => (pair.Key, Bytes: Entry(pair.Key, pair.Value))).ToArray();
        long size = Encode(now, []).Length + entries.Sum(entry => (long)entry.Bytes.Length) + Math.Max(entries.Length - 1, 0);
        var first = 0;
        while (size > ByteLimit && first < entries.Length)
        {
            size -= entries[first].Bytes.Length + (first < entries.Length - 1 ? 1 : 0);
            stamped.Remove(entries[first].Key);
            first++;
        }
        return Encode(now, entries[first..].Select(entry => entry.Bytes));
    }

    private static string Json(JsonElement element)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer)) element.WriteTo(writer);
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static byte[] Entry(string key, Stamp stamp)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartArray();
            writer.WriteRawValue(key, skipInputValidation: true);
            writer.WriteRawValue(stamp.Value, skipInputValidation: true);
            writer.WriteNumberValue(stamp.WrittenAt);
            writer.WriteEndArray();
        }
        return buffer.WrittenSpan.ToArray();
    }

    private static byte[] Encode(long now, IEnumerable<byte[]> entries)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteNumber("version", Version);
            writer.WriteNumber("writtenAt", now);
            writer.WriteStartArray("entries");
            foreach (var entry in entries) writer.WriteRawValue(entry, skipInputValidation: true);
            writer.WriteEndArray();
            writer.WriteEndObject();
        }
        return buffer.WrittenSpan.ToArray();
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (closed) return;
            closed = true;
            Flush(force: true);
            saves.Writer.TryComplete();
        }
        lifetime.Cancel();
        lifetime.Dispose();
    }

    private sealed record Document(int Version, JsonElement Entries);
    private readonly record struct Stamp(string Value, long WrittenAt);
}
