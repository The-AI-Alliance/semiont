using System.Runtime.CompilerServices;
using System.Threading.Channels;

namespace Semiont.Http;

internal sealed class Broadcast<T>(bool replayLatest = false, bool keepForFirst = false)
{
    private readonly object gate = new();
    private readonly HashSet<Channel<T>> subscribers = [];
    private bool closed;
    private readonly List<T> pending = [];
    private bool hadSubscriber;
    private bool hasLatest;
    private T? latest;

    internal async IAsyncEnumerable<T> Observe([EnumeratorCancellation] CancellationToken cancellation = default)
    {
        var channel = Channel.CreateUnbounded<T>(new UnboundedChannelOptions { AllowSynchronousContinuations = false, SingleReader = true });
        lock (gate)
        {
            if (closed)
            {
                if (replayLatest && hasLatest && latest is T final) channel.Writer.TryWrite(final);
                channel.Writer.TryComplete();
            }
            else
            {
                subscribers.Add(channel);
                if (replayLatest && hasLatest && latest is T value)
                {
                    channel.Writer.TryWrite(value);
                }
                if (keepForFirst && !hadSubscriber)
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
        await foreach (var value in Read(channel, cancellation).ConfigureAwait(false))
        {
            yield return value;
        }
    }

    private async IAsyncEnumerable<T> Read(Channel<T> channel, [EnumeratorCancellation] CancellationToken cancellation)
    {
        try
        {
            await foreach (var value in channel.Reader.ReadAllAsync(cancellation).ConfigureAwait(false))
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
                latest = value;
                hasLatest = true;
            }
            if (keepForFirst && !hadSubscriber)
            {
                pending.Add(value);
            }
            foreach (var subscriber in subscribers)
            {
                subscriber.Writer.TryWrite(value);
            }
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
        }
    }
}
