namespace Semiont.Http;

public sealed record Timing
{
    public int ReconnectMs { get; init; } = TransportFacts.Timing("reconnectMs").GetInt32();
    public int LazyRemoveMs { get; init; } = TransportFacts.Timing("lazyRemoveMs").GetInt32();
    public int LingerMs { get; init; } = TransportFacts.Timing("lingerMs").GetInt32();
    public int SeenEventIdsCount { get; init; } = TransportFacts.Timing("seenEventIdsCount").GetInt32();
    public int HttpRequestMs { get; init; } = TransportFacts.Timing("httpRequestTimeoutMs").GetInt32();
    public int StreamOpenMs { get; init; } = TransportFacts.Timing("streamOpenTimeoutMs").GetInt32();
    public int EmitTimeoutMs { get; init; } = TransportFacts.Timing("emitTimeoutMs").GetInt32();
    public int BusRequestTimeoutMs { get; init; } = TransportFacts.Timing("busRequestTimeoutMs").GetInt32();
    public RetryPolicy EmitRetry { get; init; } = new();
}

public sealed record RetryPolicy
{
    public int Attempts { get; init; } = TransportFacts.Timing("emitRetry").GetProperty("attempts").GetInt32();
    public int InitialDelayMs { get; init; } = TransportFacts.Timing("emitRetry").GetProperty("initialDelayMs").GetInt32();
    public int MaxDelayMs { get; init; } = TransportFacts.Timing("emitRetry").GetProperty("maxDelayMs").GetInt32();
}
