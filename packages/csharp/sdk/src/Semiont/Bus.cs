using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
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

/// <summary>What a transport delivers on a channel, one after another: a frame (<see cref="ReceivedBusFrame"/>), or, in
/// the place of a frame BusFrame does not allow that names its channel's readers, the frame's refusal
/// (<see cref="FrameRefusal"/>).</summary>
public closed record Carried
{
    /// <summary>The channel it was delivered on.</summary>
    public abstract string Channel { get; }

    /// <summary>What pairs it with the request awaiting it, when it carries one BusFrame allows.</summary>
    public abstract string? CorrelationId { get; }
}

public sealed record ReceivedBusFrame(BusFrame Frame, ActivityContext Trace) : Carried
{
    public override string Channel => Frame.Channel;
    public override string? CorrelationId => Frame.CorrelationId;
    internal string? EventId { get; init; }
    internal long Sequence { get; init; }

    public UserId? UserId =>
        Frame.Payload.TryGetProperty("_userId", out var value) && value.ValueKind == JsonValueKind.String &&
        Identifiers.UserId.TryParse(value.GetString(), out var user) ? user : null;
}

/// <summary>Why a frame is refused at a member, as every SDK spells it.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<FrameRefusalReason>))]
public enum FrameRefusalReason
{
    /// <summary>It does not carry the member, or the member holds null where it may not.</summary>
    [JsonStringEnumMemberName("lacks")] Lacks,

    /// <summary>The member is not what its schema allows (of another kind, another value, form or size), or is one a
    /// closed object does not name.</summary>
    [JsonStringEnumMemberName("malformed")] Malformed,
}

/// <summary>A frame refused, in its place: BusFrame does not allow it, or its payload is not its channel's.
/// <paramref name="Member"/> is the way from the frame to the member its first fault is at, the names of the members it
/// is within and its own joined by dots (<c>payload.resourceId</c> is within its payload, and <c>payload</c> is the
/// payload itself); <paramref name="Reason"/> is why. <paramref name="Payload"/> is its payload as it came, the gateway's
/// stamps and all, and null when it carried none. <paramref name="CorrelationId"/> is the frame's, when it carries one
/// BusFrame allows: a request awaiting the reply it names fails with the refusal at once.</summary>
public sealed record FrameRefusal(string Channel, string Member, FrameRefusalReason Reason, JsonElement? Payload,
    string? CorrelationId, ResourceId? Scope) : Carried
{
    public override string Channel { get; } = Channel;
    public override string? CorrelationId { get; } = CorrelationId;
}

/// <summary>What a typed read gives for each frame: the frame, its payload decoded (<see cref="Delivered"/>), or, in its
/// place, the refusal of a frame BusFrame does not allow or whose payload is not its channel's
/// (<see cref="Refused"/>).</summary>
public closed record Heard<T> where T : class
{
    public sealed record Delivered(ReceivedBusFrame Received, T Payload) : Heard<T>;
    public sealed record Refused(FrameRefusal Refusal) : Heard<T>;
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
        return Decoded<TResult>(response.Frame.Channel, response.Frame.Payload);
    }

    internal static async IAsyncEnumerable<Heard<T>> DecodeFrames<T>(IAsyncEnumerable<Carried> frames,
        ResourceId? resource, [EnumeratorCancellation] CancellationToken cancellation) where T : class
    {
        await foreach (var carried in frames.WithCancellation(cancellation).ConfigureAwait(false))
        {
            // A stream carries every scope it holds on the one channel, and another reader may hold another resource's.
            if (resource is not null && ScopeOf(carried) != resource) continue;
            yield return HeardOf<T>(carried);
        }
    }

    /// <summary>What a typed read gives for <paramref name="carried"/>: a frame, its payload decoded, or the refusal of
    /// one whose payload is not its channel's; and a frame the transport refused, its refusal as it came.</summary>
    internal static Heard<T> HeardOf<T>(Carried carried) where T : class => carried switch
    {
        FrameRefusal refusal => new Heard<T>.Refused(refusal),
        ReceivedBusFrame received => TryDecode<T>(received.Frame.Payload, out var payload, out var fault)
            ? new Heard<T>.Delivered(received, payload)
            : new Heard<T>.Refused(new FrameRefusal(received.Channel, InPayload(fault.Member), fault.Reason,
                received.Frame.Payload, received.CorrelationId, received.Frame.Scope)),
    };

    /// <summary>The resource whose scope <paramref name="carried"/> was delivered on.</summary>
    internal static ResourceId? ScopeOf(Carried carried) => carried switch
    {
        ReceivedBusFrame received => received.Frame.Scope,
        FrameRefusal refusal => refusal.Scope,
    };

    /// <summary>A payload on <paramref name="channel"/>, as <typeparamref name="T"/>. Throws
    /// <see cref="TransportError"/> (<c>error</c>) for a payload that is not that channel's, saying its first fault in
    /// every SDK's words.</summary>
    internal static T Decoded<T>(string channel, JsonElement payload) where T : class =>
        TryDecode<T>(payload, out var decoded, out var fault)
            ? decoded
            : throw new TransportError(ProtocolFacts.Error(0), "a payload on " + channel + " is not that channel's: " + fault);

    /// <summary>A payload as <typeparamref name="T"/>, held to the table before it is decoded, and decoded as the table
    /// reads it; or its first fault. What the gateway stamps on a payload (a member whose name begins <c>_</c>) is the
    /// bus's, not the payload's: one <typeparamref name="T"/> does not declare is left out before the payload is read.</summary>
    private static bool TryDecode<T>(JsonElement payload, [NotNullWhen(true)] out T? decoded,
        [NotNullWhen(false)] out Fault? fault) where T : class
    {
        decoded = null;
        fault = Required.FaultOf(typeof(T).Name, Declared(typeof(T).Name, payload), out var read);
        if (fault is not null) return false;
        try { decoded = read.Deserialize<T>() ?? throw new JsonException("A bus payload is null."); }
        catch (JsonException)
        {
            fault = Fault.Undecoded;
            return false;
        }
        return true;
    }

    /// <summary><paramref name="payload"/> without what the gateway stamped on it that <paramref name="schema"/> does
    /// not declare.</summary>
    private static JsonElement Declared(string schema, JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object) return payload;
        JsonObject? copy = null;
        foreach (var property in payload.EnumerateObject())
        {
            if (!property.Name.StartsWith('_') || WireJson.Declares(schema, property.Name)) continue;
            copy ??= JsonNode.Parse(payload.GetRawText())?.AsObject() ?? throw new JsonException("A bus payload is null.");
            copy.Remove(property.Name);
        }
        return copy is null ? payload : JsonSerializer.SerializeToElement(copy);
    }

    /// <summary>The way from a frame to the member of its payload whose way from the payload is
    /// <paramref name="member"/>.</summary>
    private static string InPayload(string member) => member.Length == 0 ? "payload" : "payload." + member;
}
