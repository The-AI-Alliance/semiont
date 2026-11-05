using System.Diagnostics;
using System.Text.Json;
using System.Threading.Channels;
using Semiont.Errors;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Jobs;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont;

public sealed record ClaimRefusal(string? Code, string Detail);
public sealed record ActiveJob(JobId JobId, JobType Type, DateTimeOffset Since);
public sealed record WorkerVitals(DateTimeOffset? LastQueuedEventAt, DateTimeOffset? LastClaimAt,
    DateTimeOffset? LastFinishedAt, DateTimeOffset? LastActivityAt, ActiveJob? ActiveJob, long JobsCompleted);
public sealed record HeldJobStall(JobId JobId, JobType JobType, DateTimeOffset HeldSince,
    DateTimeOffset LastActivityAt, long SilentForMs, int ThresholdMs);

/// <summary>One worker's claims. The first read starts the worker and StopAsync releases its job.</summary>
public sealed class Claims
{
    private readonly object gate = new();
    private readonly HttpTransport transport;
    private readonly Bus wire;
    private readonly JsonElement command;
    private readonly JsonElement[] filters;
    private readonly CancellationTokenSource watching = new();
    private readonly Channel<HeldJob> handed = Channel.CreateUnbounded<HeldJob>();
    private readonly Broadcast<ClaimRefusal> refusals = new(keepForFirst: true);
    private readonly Broadcast<HeldJobStall> stalls = new(keepForFirst: true);
    private readonly TimeProvider clock;
    private readonly Timing timing;
    private Task? pending;
    private Dictionary<JobId, long>? pendingCancellations;
    private Task? stopping;
    private HeldJob? held;
    private long claimedAtSequence;
    private bool begun;
    private bool stopped;
    private bool wakeOwed;
    private bool stallReported;
    private DateTimeOffset? lastQueued;
    private DateTimeOffset? lastClaimed;
    private DateTimeOffset? lastFinished;
    private DateTimeOffset? lastActivity;
    private long activeAt;
    private long jobsCompleted;

    internal Claims(HttpTransport transport, Bus wire, IReadOnlyList<JobFilter> accepts)
    {
        ArgumentNullException.ThrowIfNull(accepts);
        if (accepts.Count == 0) throw new ArgumentException("A worker must accept at least one job filter.", nameof(accepts));
        this.transport = transport;
        this.wire = wire;
        clock = transport.Clock;
        timing = transport.Settings;
        command = JsonSerializer.SerializeToElement(new JobClaimCommand { Accepts = accepts });
        filters = accepts.Select(filter => JsonSerializer.SerializeToElement(filter)).ToArray();
    }

    internal int CommitTimeoutMs => timing.MarkCommitTimeoutMs;

    public async Task<IHeldJob?> NextAsync(CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        Begin();
        while (await handed.Reader.WaitToReadAsync(cancellation).ConfigureAwait(false))
        {
            lock (gate)
            {
                if (stopped) return null;
                if (handed.Reader.TryRead(out var job) && !job.Settled) return job;
            }
        }
        return null;
    }

    public IAsyncEnumerable<ClaimRefusal> Refused(CancellationToken cancellation = default) => refusals.Observe(cancellation);
    public IAsyncEnumerable<HeldJobStall> Stalled(CancellationToken cancellation = default) => stalls.Observe(cancellation);

    public WorkerVitals Vitals()
    {
        lock (gate)
        {
            var active = held is { } job && lastClaimed is { } since ? new ActiveJob(job.JobId, job.JobType, since) : null;
            return new WorkerVitals(lastQueued, lastClaimed, lastFinished, lastActivity, active, jobsCompleted);
        }
    }

    public Task StopAsync()
    {
        lock (gate)
        {
            if (stopping is not null) return stopping;
            var holding = held;
            var claiming = pending;
            End();
            stopping = StopCoreAsync(holding, claiming);
            return stopping;
        }
    }

    private async Task StopCoreAsync(HeldJob? holding, Task? claiming)
    {
        if (holding is not null) await holding.FailOnStopAsync().ConfigureAwait(false);
        if (claiming is not null) await claiming.ConfigureAwait(false);
    }

    private void Begin()
    {
        lock (gate)
        {
            if (begun || stopped) return;
            var missing = WorkerRules.JobClaimChannels.Where(channel => !transport.IsSubscribed(channel)).ToArray();
            if (missing.Length != 0)
                throw new BusRequestError(ProtocolFacts.BusError("unsubscribed"), "The worker stream is missing " + string.Join(", ", missing));
            begun = true;
            var stop = watching.Token;
            _ = WatchFramesAsync(stop);
            _ = WatchStallsAsync(stop);
            _ = WatchStatesAsync(stop);
        }
    }

    private void End()
    {
        lock (gate)
        {
            if (stopped) return;
            stopped = true;
            pendingCancellations = null;
            handed.Writer.TryComplete();
            stalls.Close();
            refusals.Close();
            watching.Cancel();
            watching.Dispose();
        }
    }

    private async Task WatchStatesAsync(CancellationToken stop)
    {
        var wasOpen = false;
        try
        {
            await foreach (var state in transport.States(stop).ConfigureAwait(false))
            {
                var open = state == ConnectionState.Open;
                if (open && !wasOpen) Wake();
                wasOpen = open;
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        finally { End(); }
    }

    private async Task WatchFramesAsync(CancellationToken stop)
    {
        try
        {
            var frames = transport.ReceivedFrames([BusChannels.JobQueued.Name, BusChannels.JobCancelRequested.Name], null, stop);
            await foreach (var received in frames.ConfigureAwait(false))
            {
                var frame = received.Frame;
                if (frame.Channel == BusChannels.JobQueued.Name)
                {
                    lock (gate) lastQueued = clock.GetUtcNow();
                    if (filters.Any(filter => WorkerRules.JobMatchesFilter(filter, frame.Payload))) Wake();
                }
                else
                {
                    JobCancelRequest requested;
                    try { requested = Bus.Decode<JobCancelRequest>(frame.Payload); }
                    catch (JsonException) { continue; }
                    lock (gate)
                    {
                        if (held is { } job && requested.JobId == job.JobId && received.Sequence > claimedAtSequence)
                            job.SignalCancellation();
                        else if (pendingCancellations is { } buffered)
                            buffered[requested.JobId] = received.Sequence;
                    }
                }
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
    }

    private async Task WatchStallsAsync(CancellationToken stop)
    {
        using var interval = new PeriodicTimer(TimeSpan.FromMilliseconds(timing.HeldJobStallCheckMs), clock);
        try
        {
            while (await interval.WaitForNextTickAsync(stop).ConfigureAwait(false))
            {
                lock (gate)
                {
                    if (held is not { Settled: false } job || stallReported || lastClaimed is not { } since ||
                        lastActivity is not { } active) continue;
                    var silence = clock.GetElapsedTime(activeAt).TotalMilliseconds;
                    if (silence < timing.HeldJobStallMs) continue;
                    stallReported = true;
                    stalls.Publish(new HeldJobStall(job.JobId, job.JobType, since, active, (long)silence, timing.HeldJobStallMs));
                }
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
    }

    private void Wake()
    {
        lock (gate)
        {
            if (stopped || held is not null || transport.State != ConnectionState.Open) return;
            if (pending is not null) { wakeOwed = true; return; }
            pendingCancellations = [];
            pending = Task.Run(ClaimAsync);
        }
    }

    private async Task ClaimAsync()
    {
        // Settling may have woken this worker from the previous job's trace.
        Activity.Current = null;
        HeldJob? acquired = null;
        long replySequence = 0;
        ClaimRefusal? refused = null;
        try
        {
            var reply = await transport.RequestFrameAsync(BusOperations.JobClaim.Request.Name, command, timing.JobClaimTimeoutMs, default)
                .ConfigureAwait(false);
            replySequence = reply.Sequence;
            var record = Bus.Decode<JobClaimedResult>(reply.Frame.Payload).Response;
            acquired = record.Metadata.Type switch
            {
                JobType.Mark => new HeldMarkJob(this, wire, record, reply.Trace),
                JobType.Yield => new HeldYieldJob(this, wire, record, reply.Trace),
                _ => throw new JsonException("Unknown claimed job type."),
            };
        }
        catch (BusRequestError error)
        {
            if (error.Code != ProtocolFacts.BusError("none-pending")) refused = new ClaimRefusal(error.Code, error.Message);
        }
        catch (Exception error) when (error is TransportError or JsonException)
        {
            refused = new ClaimRefusal(null, error.Message);
        }

        lock (gate)
        {
            if (!stopped)
            {
                pending = null;
                var cancellations = pendingCancellations;
                pendingCancellations = null;
                if (acquired is { } job)
                {
                    held = job;
                    claimedAtSequence = replySequence;
                    // The event reader can see a cancellation before the claim's POST returns.
                    if (cancellations is not null && cancellations.TryGetValue(job.JobId, out var receivedAt) && receivedAt > replySequence)
                        job.SignalCancellation();
                    lastClaimed = MarkActive();
                    stallReported = false;
                    handed.Writer.TryWrite(job);
                }
                else
                {
                    if (refused is not null) refusals.Publish(refused);
                    if (wakeOwed) Wake();
                }
                wakeOwed = false;
                return;
            }
        }
        if (acquired is not null) await acquired.FailOnStopAsync().ConfigureAwait(false);
    }

    internal void Active(HeldJob job)
    {
        lock (gate)
            if (held == job) MarkActive();
    }

    internal void Release(HeldJob job, bool completed)
    {
        lock (gate)
        {
            if (held != job) return;
            held = null;
            lastFinished = MarkActive();
            if (completed) jobsCompleted++;
            Wake();
        }
    }

    private DateTimeOffset MarkActive()
    {
        activeAt = clock.GetTimestamp();
        var now = clock.GetUtcNow();
        lastActivity = now;
        return now;
    }
}
