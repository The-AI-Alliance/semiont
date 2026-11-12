using System.Runtime.CompilerServices;
using System.Threading.Channels;

namespace Semiont.Http;

/// <summary>
/// Hands each value published to every reader. Of the values published before anyone reads it, the latest
/// <paramref name="keptForFirst"/> are kept for its first reader, in the order they were published.
/// </summary>
internal sealed class Broadcast<T>(bool replayLatest = false, int keptForFirst = 0)
{
    private readonly object gate = new();
    private readonly HashSet<Channel<T>> subscribers = [];
    private readonly List<Action<T>> relays = [];
    private bool closed;
    private readonly Queue<T> pending = [];
    private bool hadSubscriber;
    private Recorded? latest;
    private sealed record Recorded(T Value);

    internal async IAsyncEnumerable<T> Observe([EnumeratorCancellation] CancellationToken cancellation = default)
    {
        var channel = Channel.CreateUnbounded<T>(new UnboundedChannelOptions { AllowSynchronousContinuations = false, SingleReader = true });
        lock (gate)
        {
            if (closed)
            {
                if (replayLatest && latest is { } final) channel.Writer.TryWrite(final.Value);
                channel.Writer.TryComplete();
            }
            else
            {
                subscribers.Add(channel);
                if (replayLatest && latest is { } value)
                {
                    channel.Writer.TryWrite(value.Value);
                }
                if (!hadSubscriber)
                {
                    foreach (var queued in pending)
                    {
                        channel.Writer.TryWrite(queued);
                    }
                    pending.Clear();
                }
                hadSubscriber = true;
            }
        }
        await foreach (var value in Read(channel, cancellation).ConfigureAwait(Spawning.Captures))
        {
            yield return value;
        }
    }

    /// <summary>
    /// Hands <paramref name="to"/> each value as it is published, until the relay is disposed or the broadcast closes. It is
    /// a reader as Observe's are: the first takes what the broadcast kept for its first reader.
    /// </summary>
    internal IDisposable Relay(Action<T> to)
    {
        var relaying = new Relaying(this, to);
        lock (gate)
        {
            if (replayLatest && latest is { } value) to(value.Value);
            if (closed) return relaying;
            relays.Add(to);
            if (!hadSubscriber)
            {
                foreach (var queued in pending) to(queued);
                pending.Clear();
            }
            hadSubscriber = true;
        }
        return relaying;
    }

    private sealed class Relaying(Broadcast<T> from, Action<T> to) : IDisposable
    {
        public void Dispose()
        {
            lock (from.gate) from.relays.Remove(to);
        }
    }

    private async IAsyncEnumerable<T> Read(Channel<T> channel, [EnumeratorCancellation] CancellationToken cancellation)
    {
        try
        {
            await foreach (var value in Spawning.ReadAll(channel.Reader, cancellation).ConfigureAwait(Spawning.Captures))
            {
                yield return value;
            }
        }
        finally
        {
            lock (gate)
            {
                subscribers.Remove(channel);
                channel.Writer.TryComplete();
            }
        }
    }

    internal void Publish(T value)
    {
        lock (gate)
        {
            if (closed) return;
            if (replayLatest)
            {
                latest = new Recorded(value);
            }
            if (!hadSubscriber)
            {
                pending.Enqueue(value);
                if (pending.Count > keptForFirst) pending.Dequeue();
            }
            foreach (var subscriber in subscribers)
            {
                subscriber.Writer.TryWrite(value);
            }
            foreach (var relay in relays) relay(value);
        }
    }

    internal void Close()
    {
        lock (gate)
        {
            closed = true;
            foreach (var subscriber in subscribers)
            {
                subscriber.Writer.TryComplete();
            }
            subscribers.Clear();
            relays.Clear();
            pending.Clear();
        }
    }
}
