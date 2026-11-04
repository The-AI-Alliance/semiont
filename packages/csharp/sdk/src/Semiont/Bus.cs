using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Semiont.Errors;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.Serialization;
using Semiont.Types;

namespace Semiont;

public sealed class BusChannel<T> where T : class
{
    internal BusChannel(string name, bool scoped) { Name = name; IsScoped = scoped; }
    public string Name { get; }
    public bool IsScoped { get; }
}

public sealed class BusOperation<TRequest, TResult, TFailure>
    where TRequest : class where TResult : class where TFailure : class
{
    internal BusOperation(BusChannel<TRequest> request, BusChannel<TResult> result, BusChannel<TFailure> failure)
    {
        Request = request;
        Result = result;
        Failure = failure;
    }

    public BusChannel<TRequest> Request { get; }
    public BusChannel<TResult> Result { get; }
    public BusChannel<TFailure> Failure { get; }
}

public sealed record ReceivedBusFrame(BusFrame Frame, ActivityContext Trace)
{
    public UserId? UserId =>
        Frame.Payload.TryGetProperty("_userId", out var value) && value.ValueKind == JsonValueKind.String &&
        Identifiers.UserId.TryParse(value.GetString(), out var user) ? user : null;
}

public closed record Heard<T>(ReceivedBusFrame Received) where T : class
{
    public sealed record Delivered(ReceivedBusFrame Received, T Payload) : Heard<T>(Received);
    public sealed record Refused(ReceivedBusFrame Received, JsonException Error) : Heard<T>(Received);
}

public sealed class Bus
{
    private readonly HttpTransport transport;

    public Bus(HttpTransport transport) => this.transport = transport;

    public Task<long?> EmitAsync<T>(BusChannel<T> channel, T payload, ResourceId? scope = null,
        string? correlationId = null, CancellationToken cancellation = default) where T : class =>
        transport.EmitAsync(channel.Name, JsonSerializer.SerializeToElement(payload), scope, correlationId, cancellation);

    public IAsyncEnumerable<Heard<T>> Frames<T>(BusChannel<T> channel, ResourceId? resource = null,
        CancellationToken cancellation = default) where T : class
    {
        if (channel.IsScoped != resource.HasValue)
            throw new ArgumentException("A resource is required exactly for a scoped channel.", nameof(resource));
        return DecodeFrames<T>(transport.ReceivedFrames([channel.Name], resource, cancellation), resource, cancellation);
    }

    public async Task<TResult> RequestAsync<TRequest, TResult, TFailure>(
        BusOperation<TRequest, TResult, TFailure> operation, TRequest payload, int? timeoutMs = null,
        CancellationToken cancellation = default)
        where TRequest : class where TResult : class where TFailure : class
    {
        var response = await transport.RequestFrameAsync(operation.Request.Name, JsonSerializer.SerializeToElement(payload),
            timeoutMs, cancellation).ConfigureAwait(false);
        try { return Decode<TResult>(response.Payload); }
        catch (JsonException error)
        {
            throw new TransportError(ProtocolFacts.Error(0), "Invalid reply on " + response.Channel, inner: error);
        }
    }

    private static async IAsyncEnumerable<Heard<T>> DecodeFrames<T>(IAsyncEnumerable<ReceivedBusFrame> frames,
        ResourceId? resource, [EnumeratorCancellation] CancellationToken cancellation) where T : class
    {
        await foreach (var received in frames.WithCancellation(cancellation).ConfigureAwait(false))
        {
            if (resource is not null && received.Frame.Scope != resource) continue;
            Heard<T> heard;
            try { heard = new Heard<T>.Delivered(received, Decode<T>(received.Frame.Payload)); }
            catch (JsonException error) { heard = new Heard<T>.Refused(received, error); }
            yield return heard;
        }
    }

    private static T Decode<T>(JsonElement payload) where T : class
    {
        JsonObject? copy = null;
        foreach (var property in payload.EnumerateObject())
        {
            if (!property.Name.StartsWith('_') || WireJson.Declares(typeof(T).Name, property.Name)) continue;
            copy ??= JsonNode.Parse(payload.GetRawText())?.AsObject() ?? throw new JsonException("Missing bus payload");
            copy.Remove(property.Name);
        }
        return (copy is null ? payload.Deserialize<T>() : copy.Deserialize<T>()) ?? throw new JsonException("Null bus payload");
    }
}
