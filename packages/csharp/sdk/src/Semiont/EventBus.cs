using System.Diagnostics;
using System.Text.Json;
using Semiont.Errors;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont;

/// <summary>In-process signals and received wire frames.</summary>
public sealed class EventBus : IDisposable
{
    private readonly object gate = new();
    private readonly Dictionary<string, Broadcast<ReceivedBusFrame>> channels = new(StringComparer.Ordinal);
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
        lock (gate)
        {
            if (!channels.TryGetValue(channel.Name, out var source))
            {
                source = new Broadcast<ReceivedBusFrame>();
                if (closed) source.Close();
                else channels.Add(channel.Name, source);
            }
            return Bus.DecodeFrames<T>(source.Observe(cancellation), resource, cancellation);
        }
    }

    internal void Receive(ReceivedBusFrame frame)
    {
        lock (gate) Publish(frame);
    }

    private void Publish(ReceivedBusFrame frame)
    {
        if (channels.TryGetValue(frame.Frame.Channel, out var source)) source.Publish(frame);
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (closed) return;
            closed = true;
            foreach (var source in channels.Values) source.Close();
            channels.Clear();
        }
    }
}
