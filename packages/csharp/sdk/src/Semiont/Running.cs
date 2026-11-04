using System.Runtime.CompilerServices;

namespace Semiont;

/// <summary>A lazy operation consumed once, by awaiting its result or reading its stream.</summary>
public sealed class Running<T> : IAsyncEnumerable<T>
{
    private readonly Func<CancellationToken, Task<T>> finish;
    private int consumed;

    internal Running(Func<CancellationToken, Task<T>> finish) => this.finish = finish;

    /// <summary>Consumes the operation and returns its final value.</summary>
    public async Task<T> CompleteAsync(CancellationToken cancellation = default)
    {
        Take();
        cancellation.ThrowIfCancellationRequested();
        return await finish(cancellation).ConfigureAwait(false);
    }

    public TaskAwaiter<T> GetAwaiter() => CompleteAsync().GetAwaiter();

    public IAsyncEnumerator<T> GetAsyncEnumerator(CancellationToken cancellationToken = default)
    {
        Take();
        return ReadAsync(cancellationToken).GetAsyncEnumerator();
    }

    private async IAsyncEnumerable<T> ReadAsync([EnumeratorCancellation] CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        yield return await finish(cancellation).ConfigureAwait(false);
    }

    private void Take()
    {
        if (Interlocked.Exchange(ref consumed, 1) != 0)
            throw new InvalidOperationException("A running operation is awaited or read once.");
    }
}
