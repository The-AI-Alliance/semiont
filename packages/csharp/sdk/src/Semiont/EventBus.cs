using System.Diagnostics;
using System.Text.Json;
using System.Runtime.CompilerServices;
using System.Threading.Channels;
using Semiont.Errors;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont;

/// <summary>In-process signals and received wire frames.</summary>
public sealed class EventBus : IDisposable
{
    private readonly object gate = new();
    private readonly Dictionary<string, HashSet<ChannelWriter<ReceivedBusFrame>>> channels = new(StringComparer.Ordinal);
    private bool closed;

    public void Emit<T>(BusChannel<T> channel, T payload, ResourceId? scope = null,
        string? correlationId = null) where T : class
    {
        if (channel.IsScoped != scope.HasValue)
            throw new ArgumentException("A resource is required exactly for a scoped channel.", nameof(scope));

        var frame = new BusFrame
        {
            Channel = channel.Name,
            Payload = JsonSerializer.SerializeToElement(payload),
            Scope = scope,
            CorrelationId = correlationId,
        };
        lock (gate)
        {
            if (closed) throw new BusRequestError(ProtocolFacts.BusError("closed"), "The local bus is closed");
            Publish(new ReceivedBusFrame(frame, Activity.Current?.Context ?? default));
        }
    }

    public IAsyncEnumerable<Heard<T>> Frames<T>(BusChannel<T> channel, ResourceId? resource = null,
        CancellationToken cancellation = default) where T : class
    {
        if (channel.IsScoped != resource.HasValue)
            throw new ArgumentException("A resource is required exactly for a scoped channel.", nameof(resource));
        return Bus.DecodeFrames<T>(ReadFrames(channel.Name, cancellation), resource, cancellation);
    }

    private async IAsyncEnumerable<ReceivedBusFrame> ReadFrames(string channel, [EnumeratorCancellation] CancellationToken cancellation)
    {
        using var subscription = Listen([channel]);
        await foreach (var frame in subscription.Reader.ReadAllAsync(cancellation).ConfigureAwait(false))
            yield return frame;
    }

    internal Subscription Listen(string[] selected)
    {
        var source = Channel.CreateUnbounded<ReceivedBusFrame>(new UnboundedChannelOptions { SingleReader = true });
        lock (gate)
        {
            if (closed) source.Writer.TryComplete();
            else
            {
                foreach (var name in selected)
                {
                    if (!channels.TryGetValue(name, out var listeners))
                        channels.Add(name, listeners = []);
                    listeners.Add(source.Writer);
                }
            }
        }
        return new Subscription(source.Reader, () =>
        {
            lock (gate)
            {
                foreach (var name in selected)
                {
                    if (channels.TryGetValue(name, out var listeners) && listeners.Remove(source.Writer) && listeners.Count == 0)
                        channels.Remove(name);
                }
                source.Writer.TryComplete();
            }
        });
    }

    internal sealed class Subscription(ChannelReader<ReceivedBusFrame> reader, Action close) : IDisposable
    {
        private Action? release = close;
        internal ChannelReader<ReceivedBusFrame> Reader { get; } = reader;
        public void Dispose() => Interlocked.Exchange(ref release, null)?.Invoke();
    }

    internal void Receive(ReceivedBusFrame frame)
    {
        lock (gate) Publish(frame);
    }

    private void Publish(ReceivedBusFrame frame)
    {
        if (channels.TryGetValue(frame.Frame.Channel, out var listeners))
            foreach (var listener in listeners) listener.TryWrite(frame);
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (closed) return;
            closed = true;
            foreach (var listeners in channels.Values)
                foreach (var listener in listeners) listener.TryComplete();
            channels.Clear();
        }
    }
}
