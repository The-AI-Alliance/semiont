using Semiont.Protocol;
using Semiont.State;

namespace Semiont;

/// <summary>A client or host owned cache. Equal keys share a live query and its pending fetch.</summary>
public sealed class Cache<TKey, T> : IStateUnit, IRefreshedCache where TKey : notnull
{
    private readonly object gate = new();
    private readonly Dictionary<TKey, CacheEntry<T>> entries = [];
    private readonly Func<TKey, CancellationToken, Task<T>> fetch;
    private readonly Func<TKey, IDisposable?>? hold;
    private readonly TimeProvider clock;
    private readonly TimeSpan window;
    private readonly Action? changed;
    private IKeptQuery? keeper;
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

    public Cached<T> Observe(TKey key) => Entry(key);

    internal CacheEntry<T> Entry(TKey key)
    {
        lock (gate)
        {
            if (entries.TryGetValue(key, out var found)) return found;
            var query = new CacheEntry<T>(cancellation => fetch(key, cancellation), () => hold?.Invoke(key), clock, window, changed);
            if (closed) query.Close();
            else entries.Add(key, query);
            return query;
        }
    }

    public Task<T> FetchAsync(TKey key, CancellationToken cancellation = default) => Observe(key).FreshAsync(cancellation);
    public CacheState<T>.Ready? Get(TKey key) => Find(key)?.CurrentValue;
    public bool Known(TKey key) => Find(key)?.IsKnown == true;
    public IReadOnlyList<TKey> Keys() => Array.AsReadOnly(Snapshot().Where(pair => pair.Value.IsKnown).Select(pair => pair.Key).ToArray());

    /// <summary>A cache that keeps its values has not yet kept what it knows: a fetch is in flight, or a save is owed.</summary>
    public bool PersistencePending => keeper is { Pending: true };

    internal void KeptBy(IKeptQuery query) => keeper = query;

    internal bool Fetching => Snapshot().Any(pair => pair.Value.Fetching);
    bool IRefreshedCache.RefetchOwed => Snapshot().Any(pair => pair.Value.RefetchOwed);

    public void Invalidate(TKey key) => Observe(key).Invalidate();
    public void InvalidateAll()
    {
        foreach (var pair in Snapshot()) pair.Value.Refresh(coalesce: false);
    }

    public void Set(TKey key, T value) => Entry(key).Set(value);

    /// <summary>
    /// Writes part of <paramref name="key"/>'s value: <paramref name="change"/> takes the value to the patched one. It
    /// applies at once to the value the key holds, and to the reply of the key's fetch in flight when it lands, which
    /// <see cref="Set"/> would let go of. A key the cache does not hold is not changed.
    /// </summary>
    public void Patch(TKey key, Func<T, T> change)
    {
        if (Find(key) is { } entry) entry.Patch(change);
    }

    public void Remove(TKey key) => Entry(key).Remove();

    internal KeyValuePair<TKey, CacheEntry<T>>[] Snapshot()
    {
        lock (gate) return entries.ToArray();
    }

    internal CacheEntry<T>? Find(TKey key)
    {
        lock (gate) return entries.GetValueOrDefault(key);
    }

    public void Dispose()
    {
        CacheEntry<T>[] ending;
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

/// <summary>A cache the refresher refetches through.</summary>
internal interface IRefreshedCache : IDisposable
{
    /// <summary>One of its keys' B19 windows holds an invalidation it has not yet run.</summary>
    public bool RefetchOwed { get; }
}
