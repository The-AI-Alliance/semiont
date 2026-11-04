using System.Text.Json;
using System.Threading.Channels;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Protocol;

namespace Semiont;

/// <summary>Reads and replaces one cache document for a single knowledge base and principal.</summary>
public sealed record CachePersistence(Func<string?> Read, Action<string> Write);

internal sealed record SavedCacheValue(string Cache, JsonElement Key, JsonElement Value, long Written);

internal interface ISavedCache
{
    public string Name { get; }
    public bool Collect(List<SavedCacheValue> values, bool requireIdle);
    public void Rehydrate(SavedCacheValue value);
}

internal sealed class LiveCacheStorage(CachePersistence storage, TimeProvider clock) : IDisposable
{
    private const int Version = 1;
    private static readonly int ByteLimit = ProtocolFacts.Timing("maxStoredBytesCount").GetInt32();
    private static readonly TimeSpan Debounce = TimeSpan.FromMilliseconds(ProtocolFacts.Timing("saveDebounceMs").GetInt32());
    private readonly object gate = new();
    private readonly Channel<bool> saves = Channel.CreateBounded<bool>(1);
    private readonly CancellationTokenSource lifetime = new();
    private readonly Dictionary<string, string> pendingBookmarks = new(StringComparer.Ordinal);
    private Dictionary<string, string> savedBookmarks = new(StringComparer.Ordinal);
    private ISavedCache[] caches = [];
    private int dirty;
    private bool closed;

    internal void Start(HttpTransport transport, ISavedCache[] persisted)
    {
        caches = persisted;
        var document = Load();
        if (document is { Version: Version, Values: not null, Bookmarks: not null })
        {
            var byName = caches.ToDictionary(cache => cache.Name, StringComparer.Ordinal);
            foreach (var value in document.Values)
                if (value?.Cache is { } name && byName.TryGetValue(name, out var cache)) cache.Rehydrate(value);
            foreach (var (scope, id) in document.Bookmarks)
                if (ResourceId.TryParse(scope, out _) && IsBookmark(id)) savedBookmarks.Add(scope, id);
            transport.RestoreWatermarks(savedBookmarks);
        }
        _ = SaveWhenQuietAsync(lifetime.Token);
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
            if (frame.Frame.Scope is ResourceId resource && IsBookmark(frame.EventId))
            {
                // The event's invalidations are in flight before its position can be saved.
                pendingBookmarks[resource.Value] = frame.EventId;
                Changed();
            }
        }
    }

    private static bool IsBookmark([System.Diagnostics.CodeAnalysis.NotNullWhen(true)] string? id) =>
        id is not null && id.StartsWith("p-", StringComparison.Ordinal);

    private Document? Load()
    {
        try { return storage.Read() is { } text ? JsonSerializer.Deserialize<Document>(text) : null; }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException) { return null; }
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
        if (Interlocked.Exchange(ref dirty, 0) == 0) return true;
        var values = new List<SavedCacheValue>();
        var idle = caches.All(cache => cache.Collect(values, requireIdle: true));
        if (!idle)
        {
            if (!force)
            {
                Interlocked.Exchange(ref dirty, 1);
                return false;
            }
            values.Clear();
            foreach (var cache in caches) cache.Collect(values, requireIdle: false);
        }
        var bookmarks = new Dictionary<string, string>(savedBookmarks, StringComparer.Ordinal);
        if (idle)
            foreach (var (scope, id) in pendingBookmarks) bookmarks[scope] = id;

        try
        {
            var bytes = Bounded(values, bookmarks);
            storage.Write(System.Text.Encoding.UTF8.GetString(bytes));
            savedBookmarks = bookmarks;
            if (idle) pendingBookmarks.Clear();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // The next write can try again. Failed persistence does not affect the live view.
        }
        return true;
    }

    private static byte[] Bounded(List<SavedCacheValue> values, Dictionary<string, string> bookmarks)
    {
        var ordered = values.OrderBy(value => value.Written).ToArray();
        byte[] Encode(int start) => JsonSerializer.SerializeToUtf8Bytes(new Document(Version, ordered[start..], bookmarks));
        var encoded = Encode(0);
        if (encoded.Length <= ByteLimit) return encoded;
        var empty = Encode(ordered.Length);
        if (empty.Length > ByteLimit)
        {
            bookmarks.Clear();
            empty = Encode(ordered.Length);
        }
        var low = 0;
        var high = ordered.Length;
        var best = empty;
        while (low < high)
        {
            var middle = low + (high - low) / 2;
            encoded = Encode(middle);
            if (encoded.Length > ByteLimit) low = middle + 1;
            else { high = middle; best = encoded; }
        }
        return best;
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

    private sealed record Document(int Version, SavedCacheValue[] Values, Dictionary<string, string> Bookmarks);
}
