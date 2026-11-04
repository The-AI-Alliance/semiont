using System.Text.Json;
using Semiont.Protocol;

namespace Semiont;

/// <summary>A client or host owned cache. Equal keys share a live query and its pending fetch.</summary>
public sealed class Cache<TKey, T> : IDisposable where TKey : notnull
{
    private readonly object gate = new();
    private readonly Dictionary<TKey, Cached<T>> entries = [];
    private readonly Func<TKey, CancellationToken, Task<T>> fetch;
    private readonly Func<TKey, IDisposable?>? hold;
    private readonly TimeProvider clock;
    private readonly TimeSpan window;
    private readonly Action? changed;
    private bool closed;

    public Cache(Func<TKey, CancellationToken, Task<T>> fetch, TimeProvider? timeProvider = null)
        : this(fetch, null, timeProvider ?? TimeProvider.System,
            TimeSpan.FromMilliseconds(ProtocolFacts.Timing("invalidationWindowMs").GetInt32()))
    { }

    internal Cache(Func<TKey, CancellationToken, Task<T>> fetch, Func<TKey, IDisposable?>? hold, TimeProvider clock, TimeSpan window, Action? changed = null)
    {
        this.fetch = fetch;
        this.hold = hold;
        this.clock = clock;
        this.window = window;
        this.changed = changed;
    }

    public Cached<T> Observe(TKey key)
    {
        lock (gate)
        {
            if (entries.TryGetValue(key, out var found)) return found;
            var query = new Cached<T>(cancellation => fetch(key, cancellation), () => hold?.Invoke(key), clock, window, changed);
            if (closed) query.Close();
            else entries.Add(key, query);
            return query;
        }
    }

    public Task<T> FetchAsync(TKey key, CancellationToken cancellation = default) => Observe(key).FreshAsync(cancellation);
    public void Invalidate(TKey key) => Observe(key).Invalidate();
    public void InvalidateAll()
    {
        foreach (var pair in Snapshot()) pair.Value.Refresh(coalesce: false);
    }

    public void Set(TKey key, T value) => Observe(key).Set(value);

    public void Remove(TKey key) => Observe(key).Remove();

    internal KeyValuePair<TKey, Cached<T>>[] Snapshot()
    {
        lock (gate) return entries.ToArray();
    }

    internal Cached<T>? Find(TKey key)
    {
        lock (gate) return entries.GetValueOrDefault(key);
    }

    internal ISavedCache PersistAs(string name) => new SavedCache(this, name);

    private sealed class SavedCache(Cache<TKey, T> cache, string name) : ISavedCache
    {
        public string Name => name;

        public bool Collect(List<SavedCacheValue> values, bool requireIdle)
        {
            foreach (var (key, query) in cache.Snapshot())
            {
                if (!query.Snapshot(requireIdle, out var ready, out var written)) return false;
                if (ready is not null)
                    values.Add(new SavedCacheValue(name, JsonSerializer.SerializeToElement(key),
                        JsonSerializer.SerializeToElement(ready.Value), written));
            }
            return true;
        }

        public void Rehydrate(SavedCacheValue saved)
        {
            if (saved.Key.ValueKind == JsonValueKind.Undefined || saved.Value.ValueKind == JsonValueKind.Undefined) return;
            try
            {
                var key = saved.Key.Deserialize<TKey>();
                var value = saved.Value.Deserialize<T>();
                if (key is not null && value is not null) cache.Observe(key).Rehydrate(value, saved.Written);
            }
            catch (JsonException) { /* An invalid saved value is treated as absent. */ }
        }
    }

    public void Dispose()
    {
        Cached<T>[] ending;
        lock (gate)
        {
            if (closed) return;
            closed = true;
            ending = entries.Values.ToArray();
            entries.Clear();
        }
        foreach (var query in ending) query.Close();
    }
}
