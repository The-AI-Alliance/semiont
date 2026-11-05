using Semiont.Http;

namespace Semiont.State;

/// <summary>Composition owned by its caller. Disposal ends its work and its state readers.</summary>
public interface IStateUnit : IDisposable;

/// <summary>A read-only value and a stream of its changes, starting at the current value.</summary>
public sealed class StateValue<T> : IAsyncEnumerable<T>
{
    private readonly object gate = new();
    private readonly Broadcast<T> changes = new(replayLatest: true);
    private T value;
    private bool closed;

    internal StateValue(T initial)
    {
        value = initial;
        changes.Publish(initial);
    }

    public T Value { get { lock (gate) return value; } }

    public IAsyncEnumerator<T> GetAsyncEnumerator(CancellationToken cancellationToken = default) =>
        changes.Observe(cancellationToken).GetAsyncEnumerator();

    internal void Set(T next, bool repeat = false)
    {
        lock (gate)
        {
            if (closed || !repeat && EqualityComparer<T>.Default.Equals(value, next)) return;
            value = next;
            changes.Publish(next);
        }
    }

    internal void Close()
    {
        lock (gate)
        {
            closed = true;
            changes.Close();
        }
    }
}

internal sealed class UnitWork : IDisposable
{
    private readonly CancellationTokenSource lifetime;
    internal object Gate { get; } = new();
    internal CancellationToken Token { get; }
    internal bool Active => !Token.IsCancellationRequested;

    internal UnitWork(CancellationToken parent = default)
    {
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(parent);
        Token = lifetime.Token;
    }

    internal void Run(Func<CancellationToken, Task> work) => _ = ObserveAsync(work(Token));

    internal static async Task ObserveAsync(Task task) => await task.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);

    public void Dispose()
    {
        lock (Gate)
        {
            if (disposed) return;
            disposed = true;
            _ = CancelAndDisposeAsync(lifetime);
        }
    }

    private bool disposed;

    private static async Task CancelAndDisposeAsync(CancellationTokenSource source)
    {
        await source.CancelAsync().ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        source.Dispose();
    }
}
