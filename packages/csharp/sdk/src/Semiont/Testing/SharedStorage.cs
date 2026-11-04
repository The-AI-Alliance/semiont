using Semiont.Storage;

namespace Semiont.Testing;

/// <summary>Contexts share atomic updates and observe writes from the other contexts.</summary>
public sealed class SharedStorage : ISessionStorage
{
    private readonly Shared shared;

    public SharedStorage() : this(new Shared()) { }
    private SharedStorage(Shared shared) => this.shared = shared;

    public SharedStorage Context() => new(shared);
    public string? Get(string key) { lock (shared) return shared.Values.GetValueOrDefault(key); }
    public void Set(string key, string value) => Update(key, _ => value);
    public void Delete(string key) => Update(key, _ => null);

    public void Update(string key, Func<string?, string?> change)
    {
        string? next;
        Subscription[] notify;
        lock (shared)
        {
            var previous = shared.Values.GetValueOrDefault(key);
            next = change(previous);
            if (next == previous) return;
            if (next is null) shared.Values.Remove(key);
            else shared.Values[key] = next;
            notify = shared.Listeners.Where(listener => listener.Context != this).ToArray();
        }
        foreach (var listener in notify) listener.Notify(key, next);
    }

    public IDisposable Subscribe(Action<string, string?> onChange)
    {
        var subscription = new Subscription(this, onChange);
        lock (shared) shared.Listeners.Add(subscription);
        return subscription;
    }

    private sealed class Shared
    {
        internal Dictionary<string, string> Values { get; } = new(StringComparer.Ordinal);
        internal List<Subscription> Listeners { get; } = [];
    }

    private sealed class Subscription(SharedStorage context, Action<string, string?> notify) : IDisposable
    {
        internal SharedStorage Context { get; } = context;
        internal void Notify(string key, string? value) => notify(key, value);
        public void Dispose() { lock (Context.shared) Context.shared.Listeners.Remove(this); }
    }
}
