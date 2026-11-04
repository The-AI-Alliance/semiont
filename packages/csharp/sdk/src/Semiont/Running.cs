using System.Runtime.CompilerServices;
using System.Threading.Channels;

namespace Semiont;

/// <summary>A lazy operation consumed once, by awaiting its result or reading its stream.</summary>
public sealed class Running<T> : IAsyncEnumerable<T>
{
    private readonly Func<Action<T>?, CancellationToken, Task<T>> finish;
    private int consumed;

    internal Running(Func<Action<T>?, CancellationToken, Task<T>> finish) => this.finish = finish;

    /// <summary>Consumes the operation and returns its final value.</summary>
    public async Task<T> CompleteAsync(CancellationToken cancellation = default)
    {
        Take();
        cancellation.ThrowIfCancellationRequested();
        return await finish(null, cancellation).ConfigureAwait(false);
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
        using var reading = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        var reports = Channel.CreateUnbounded<T>();
        var result = RunAsync();
        try
        {
            await foreach (var report in reports.Reader.ReadAllAsync(cancellation).ConfigureAwait(false))
                yield return report;
            yield return await result.ConfigureAwait(false);
        }
        finally
        {
            reading.Cancel();
            // The reader may have left before seeing the result. Settle its work either way.
            await ((Task)result).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        }

        async Task<T> RunAsync()
        {
            try { return await finish(value => reports.Writer.TryWrite(value), reading.Token).ConfigureAwait(false); }
            finally { reports.Writer.TryComplete(); }
        }
    }

    private void Take()
    {
        if (Interlocked.Exchange(ref consumed, 1) != 0)
            throw new InvalidOperationException("A running operation is awaited or read once.");
    }
}
