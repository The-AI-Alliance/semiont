namespace Semiont.Storage;

/// <summary>Caller-owned text storage. Update runs the read, transform and write as one operation.</summary>
public interface ISessionStorage
{
    public string? Get(string key);
    public void Set(string key, string value);
    public void Delete(string key);
    public void Update(string key, Func<string?, string?> change);
    /// <summary>Observes writes from other contexts. A store without other contexts returns null.</summary>
    public IDisposable? Subscribe(Action<string, string?> onChange);
}

public sealed class MemoryStorage : ISessionStorage
{
    private readonly object gate = new();
    private readonly Dictionary<string, string> values = new(StringComparer.Ordinal);

    public string? Get(string key) { lock (gate) return values.GetValueOrDefault(key); }
    public void Set(string key, string value) { lock (gate) values[key] = value; }
    public void Delete(string key) { lock (gate) values.Remove(key); }

    public void Update(string key, Func<string?, string?> change)
    {
        lock (gate)
        {
            if (change(values.GetValueOrDefault(key)) is { } next) values[key] = next;
            else values.Remove(key);
        }
    }

    public IDisposable? Subscribe(Action<string, string?> onChange) => null;
}
