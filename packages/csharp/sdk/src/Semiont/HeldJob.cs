using System.Diagnostics;
using System.Text.Json;
using Semiont.Errors;
using Semiont.Identifiers;
using Semiont.Jobs;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont;

public interface IHeldJob
{
    public JobId JobId { get; }
    public JobType JobType { get; }
    public ResourceId ResourceId { get; }
    public JobParams Params { get; }
    public IReadOnlyList<string> CompletedUnits { get; }
    public IReadOnlyDictionary<string, UnitCursor> UnitCursors { get; }
    public long RetryCount { get; }
    public long MaxRetries { get; }
    public long Attempt { get; }
    public AnnotationId? AnnotationId { get; }
    public ActivityContext Trace { get; }
    public CancellationToken Cancelled { get; }
    public bool Settled { get; }
    public Task StartAsync(CancellationToken cancellation = default);
    public Task ProgressAsync(JobProgress progress, CancellationToken cancellation = default);
    public Task CheckpointAsync(IReadOnlyList<string> completedUnits, IReadOnlyDictionary<string, UnitCursor>? unitCursors = null, CancellationToken cancellation = default);
    public Task CommitAsync(ResourceId resourceId, IReadOnlyList<Annotation> annotations, CancellationToken cancellation = default);
    public Task FailAsync(string error, FailureClass? failureClass = null, IReadOnlyList<string>? completedUnits = null,
        IReadOnlyDictionary<string, UnitCursor>? unitCursors = null, CancellationToken cancellation = default);
    public Task CancelAsync(IReadOnlyList<string>? completedUnits = null, IReadOnlyDictionary<string, UnitCursor>? unitCursors = null,
        CancellationToken cancellation = default);
}

/// <summary>A claimed job. Its lifecycle operations are serialized and it settles once.</summary>
public abstract class HeldJob : IHeldJob
{
    private readonly Claims holder;
    private readonly Bus wire;
    private readonly JobRunning job;
    private readonly SemaphoreSlim turn = new(1, 1);
    private readonly CancellationTokenSource cancelled = new();
    private Task? signalling;
    private DurabilityEvidence? durability;
    private bool begun;
    private volatile bool settled;

    private protected HeldJob(Claims holder, Bus wire, JobRunning job, ActivityContext trace)
    {
        this.holder = holder;
        this.wire = wire;
        this.job = job;
        Cancelled = cancelled.Token;
        Trace = trace;
        if (JobType == JobType.Yield && Params.AdditionalProperties.TryGetValue("context", out var context) &&
            context.ValueKind == JsonValueKind.Object && context.TryGetProperty("focus", out var focus) &&
            focus.Deserialize<GatheredContextFocus>() is GatheredContextFocus.AnnotationCase(var anchored))
            AnnotationId = anchored.Annotation.Id;
    }

    public JobId JobId => job.Metadata.Id;
    public JobType JobType => job.Metadata.Type;
    public ResourceId ResourceId => Params.ResourceId;
    public JobParams Params => job.Params;
    public IReadOnlyList<string> CompletedUnits => job.Metadata.CompletedUnits ?? [];
    public IReadOnlyDictionary<string, UnitCursor> UnitCursors => job.Metadata.UnitCursors ?? EmptyCursors;
    public long RetryCount => job.Metadata.RetryCount;
    public long MaxRetries => job.Metadata.MaxRetries;
    public long Attempt => RetryCount + 1;
    public AnnotationId? AnnotationId { get; }
    public ActivityContext Trace { get; }
    public CancellationToken Cancelled { get; }
    public bool Settled => settled;
    private static readonly IReadOnlyDictionary<string, UnitCursor> EmptyCursors =
        System.Collections.ObjectModel.ReadOnlyDictionary<string, UnitCursor>.Empty;

    public Task StartAsync(CancellationToken cancellation = default) => WhileHeldAsync(async () =>
    {
        if (begun) throw new InvalidOperationException("Start must be the job's first lifecycle message.");
        begun = true;
        await wire.EmitAsync(BusChannels.JobStart, new JobStartCommand
        {
            JobId = JobId,
            JobType = JobType,
            ResourceId = ResourceId,
            Attempt = Attempt,
            AnnotationId = AnnotationId,
        }, cancellation: cancellation).ConfigureAwait(false);
    }, cancellation);

    public Task ProgressAsync(JobProgress progress, CancellationToken cancellation = default) => WhileHeldAsync(async () =>
    {
        Working();
        await wire.EmitAsync(BusChannels.JobReportProgress, new JobReportProgressCommand
        {
            JobId = JobId,
            JobType = JobType,
            ResourceId = ResourceId,
            Attempt = Attempt,
            AnnotationId = AnnotationId,
            Percentage = progress.Percentage,
            Progress = AnnotationId is { } anchor ? progress with { AnnotationId = anchor } : progress,
        }, cancellation: cancellation).ConfigureAwait(false);
    }, cancellation);

    public Task CheckpointAsync(IReadOnlyList<string> completedUnits, IReadOnlyDictionary<string, UnitCursor>? unitCursors = null,
        CancellationToken cancellation = default) => WhileHeldAsync(async () =>
    {
        Working();
        await wire.EmitAsync(BusChannels.JobCheckpoint, new JobCheckpointCommand
        {
            JobId = JobId,
            CompletedUnits = completedUnits,
            UnitCursors = unitCursors,
        }, cancellation: cancellation).ConfigureAwait(false);
    }, cancellation);

    public Task CommitAsync(ResourceId resourceId, IReadOnlyList<Annotation> annotations, CancellationToken cancellation = default) =>
        WhileHeldAsync(async () =>
        {
            if (annotations.Count == 0) return;
            var last = annotations[^1].Id;
            try
            {
                await wire.RequestAsync(BusOperations.MarkCommit, new MarkCommitCommand
                {
                    JobId = JobId,
                    ResourceId = resourceId,
                    Annotations = annotations,
                }, holder.CommitTimeoutMs, cancellation).ConfigureAwait(false);
            }
            catch (BusRequestError error) when (error.Code == ProtocolFacts.BusError("timeout"))
            {
                var observed = await ProbeAsync(resourceId, last, cancellation).ConfigureAwait(false);
                Observe(observed);
                if (observed != DurabilityEvidence.ProbeConfirmed) throw;
                return;
            }
            Observe(DurabilityEvidence.Acknowledged);
        }, cancellation);

    private async Task<DurabilityEvidence> ProbeAsync(ResourceId resourceId, AnnotationId annotationId, CancellationToken cancellation)
    {
        try
        {
            var answer = await wire.RequestAsync(BusOperations.BrowseAnnotationRequested,
                new BrowseAnnotationRequest { ResourceId = resourceId, AnnotationId = annotationId },
                holder.CommitTimeoutMs, cancellation).ConfigureAwait(false);
            return answer.Response.Annotation.Id == annotationId ? DurabilityEvidence.ProbeConfirmed : DurabilityEvidence.ProbeRefused;
        }
        catch (BusRequestError error) when (error.Code != ProtocolFacts.BusError("timeout") &&
            error.Code != ProtocolFacts.BusError("closed") && error.Code != ProtocolFacts.BusError("unsubscribed"))
        {
            return DurabilityEvidence.ProbeRefused;
        }
        catch (SemiontError) { return DurabilityEvidence.ProbeUnreachable; }
    }

    private static int Weakness(DurabilityEvidence evidence) => evidence switch
    {
        DurabilityEvidence.Acknowledged => 0,
        DurabilityEvidence.ProbeConfirmed => 1,
        DurabilityEvidence.ProbeRefused or DurabilityEvidence.ProbeUnreachable => 2,
        _ => throw new ArgumentOutOfRangeException(nameof(evidence)),
    };

    private void Observe(DurabilityEvidence evidence)
    {
        if (durability is not { } previous || Weakness(evidence) > Weakness(previous)) durability = evidence;
    }

    public Task FailAsync(string error, FailureClass? failureClass = null, IReadOnlyList<string>? completedUnits = null,
        IReadOnlyDictionary<string, UnitCursor>? unitCursors = null, CancellationToken cancellation = default) =>
        SettleAsync(() => SayFailureAsync(error, failureClass, completedUnits, unitCursors, cancellation), false, cancellation);

    private Task SayFailureAsync(string error, FailureClass? failureClass, IReadOnlyList<string>? completedUnits,
        IReadOnlyDictionary<string, UnitCursor>? unitCursors, CancellationToken cancellation) =>
        wire.EmitAsync(BusChannels.JobFail, new JobFailCommand
        {
            JobId = JobId,
            JobType = JobType,
            ResourceId = ResourceId,
            Attempt = Attempt,
            AnnotationId = AnnotationId,
            Error = error,
            FailureClass = failureClass,
            CompletedUnits = completedUnits,
            UnitCursors = unitCursors,
            WillRetry = WorkerRules.WillRetryAfter(RetryCount, MaxRetries, failureClass),
            Durability = durability is DurabilityEvidence.ProbeRefused or DurabilityEvidence.ProbeUnreachable ? durability : null,
        }, cancellation: cancellation);

    public Task CancelAsync(IReadOnlyList<string>? completedUnits = null, IReadOnlyDictionary<string, UnitCursor>? unitCursors = null,
        CancellationToken cancellation = default) => SettleAsync(() => wire.EmitAsync(BusChannels.JobCancel, new JobCancelCommand
        {
            JobId = JobId,
            JobType = JobType,
            ResourceId = ResourceId,
            AnnotationId = AnnotationId,
            CompletedUnits = completedUnits,
            UnitCursors = unitCursors,
        }, cancellation: cancellation), false, cancellation);

    private protected Task CompleteAsync(Func<DurabilityEvidence?, JobCompleteCommand> command, CancellationToken cancellation) =>
        SettleAsync(() => wire.EmitAsync(BusChannels.JobComplete, command(durability), cancellation: cancellation), true, cancellation);

    internal async Task FailOnStopAsync()
    {
        await turn.WaitAsync().ConfigureAwait(false);
        try
        {
            if (settled) return;
            using var context = Trace != default
                ? new Activity("worker stop").SetParentId(Trace.TraceId, Trace.SpanId, Trace.TraceFlags) : null;
            if (context is not null)
            {
                context.TraceStateString = Trace.TraceState;
                context.Start();
            }
            await FinishAsync(() => SayFailureAsync("The worker stopped while it held the job", null, null, null, default), false).ConfigureAwait(false);
        }
        catch (SemiontError) { /* The dispatcher's sweep handles a failure the worker could not deliver. */ }
        finally { turn.Release(); }
    }

    internal void SignalCancellation()
    {
        if (!settled && signalling is null) signalling = cancelled.CancelAsync();
    }

    private async Task EndCancellationAsync()
    {
        if (signalling is not null) await signalling.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        cancelled.Dispose();
    }

    private void Working()
    {
        begun = true;
        holder.Active(this);
    }

    private async Task WhileHeldAsync(Func<Task> action, CancellationToken cancellation)
    {
        await turn.WaitAsync(cancellation).ConfigureAwait(false);
        try
        {
            RequireHeld();
            await action().ConfigureAwait(false);
        }
        finally { turn.Release(); }
    }

    private Task SettleAsync(Func<Task> action, bool completed, CancellationToken cancellation) =>
        WhileHeldAsync(() => FinishAsync(action, completed), cancellation);

    private async Task FinishAsync(Func<Task> action, bool completed)
    {
        settled = true;
        var delivered = false;
        try
        {
            await action().ConfigureAwait(false);
            delivered = true;
        }
        finally
        {
            holder.Release(this, completed && delivered);
            _ = EndCancellationAsync();
        }
    }

    private void RequireHeld()
    {
        if (settled) throw new InvalidOperationException("Job " + JobId.Value + " is already settled.");
    }
}

public sealed class HeldMarkJob : HeldJob
{
    internal HeldMarkJob(Claims holder, Bus wire, JobRunning job, ActivityContext trace) : base(holder, wire, job, trace) { }

    public Task CompleteAsync(MarkJobResult result, CancellationToken cancellation = default) => CompleteAsync(
        durability => new JobCompleteCommand.MarkJobCompleteCommandCase(new MarkJobCompleteCommand
        {
            JobId = JobId,
            ResourceId = ResourceId,
            Attempt = Attempt,
            Result = result,
            Durability = durability,
        }), cancellation);
}

public sealed class HeldYieldJob : HeldJob
{
    internal HeldYieldJob(Claims holder, Bus wire, JobRunning job, ActivityContext trace) : base(holder, wire, job, trace) { }

    public Task CompleteAsync(YieldJobResult result, CancellationToken cancellation = default) => CompleteAsync(
        durability => new JobCompleteCommand.YieldJobCompleteCommandCase(new YieldJobCompleteCommand
        {
            JobId = JobId,
            ResourceId = ResourceId,
            Attempt = Attempt,
            AnnotationId = AnnotationId,
            Result = result,
            Durability = durability,
        }), cancellation);
}
