using Semiont.Protocol;
namespace Semiont.Http;

public sealed record Timing
{
    public int ReconnectMs { get; init; } = ProtocolFacts.Timing("reconnectMs").GetInt32();
    public int LazyRemoveMs { get; init; } = ProtocolFacts.Timing("lazyRemoveMs").GetInt32();
    public int LingerMs { get; init; } = ProtocolFacts.Timing("lingerMs").GetInt32();
    public int SeenEventIdsCount { get; init; } = ProtocolFacts.Timing("seenEventIdsCount").GetInt32();
    public int HttpRequestMs { get; init; } = ProtocolFacts.Timing("httpRequestTimeoutMs").GetInt32();
    public int StreamOpenMs { get; init; } = ProtocolFacts.Timing("streamOpenTimeoutMs").GetInt32();
    public int EmitTimeoutMs { get; init; } = ProtocolFacts.Timing("emitTimeoutMs").GetInt32();
    public int BusRequestTimeoutMs { get; init; } = ProtocolFacts.Timing("busRequestTimeoutMs").GetInt32();
    public int InvalidationWindowMs { get; init; } = ProtocolFacts.Timing("invalidationWindowMs").GetInt32();
    public int JobSilenceMs { get; init; } = ProtocolFacts.Timing("jobSilenceMs").GetInt32();
    public int JobStatusPollMs { get; init; } = ProtocolFacts.Timing("jobStatusPollMs").GetInt32();
    public int JobClaimTimeoutMs { get; init; } = ProtocolFacts.Timing("jobClaimTimeoutMs").GetInt32();
    public int HeldJobStallMs { get; init; } = ProtocolFacts.Timing("heldJobStallMs").GetInt32();
    public int HeldJobStallCheckMs { get; init; } = ProtocolFacts.Timing("heldJobStallCheckMs").GetInt32();
    public int MarkCommitTimeoutMs { get; init; } = ProtocolFacts.Timing("markCommitTimeoutMs").GetInt32();
    public RetryPolicy EmitRetry { get; init; } = RetryPolicy.FromTiming("emitRetry");
}

public sealed record RetryPolicy(int Attempts, int InitialDelayMs, int MaxDelayMs)
{
    internal static RetryPolicy FromTiming(string entry)
    {
        var budget = ProtocolFacts.Timing(entry);
        return new(budget.GetProperty("attempts").GetInt32(), budget.GetProperty("initialDelayMs").GetInt32(), budget.GetProperty("maxDelayMs").GetInt32());
    }
}
