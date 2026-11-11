using Semiont.Errors;
using Semiont.Identifiers;
using Semiont.Http;
using Semiont.Namespaces;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont;

internal sealed class JobFollower(Bus wire, EventBus bus, JobNamespace jobs, TimeProvider clock, CancellationToken closed, Timing timing)
{
    private static readonly string[] LifecycleChannels =
        [BusChannels.JobReportProgress.Name, BusChannels.JobFail.Name, BusChannels.JobComplete.Name];

    internal Delegation<T> Follow<T>(JobCreateCommand command, ResourceId resource, Func<JobCompleteCommand, T> complete,
        int? stallMs = null) => new((report, cancellation) => FollowAsync(command, resource, complete, stallMs, report, cancellation));

    private async Task<T> FollowAsync<T>(JobCreateCommand command, ResourceId resource, Func<JobCompleteCommand, T> complete,
        int? stallMs, Action<JobEvent<T>>? report, CancellationToken cancellation)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellation, closed);
        var stop = lifetime.Token;
        using var events = bus.Listen(LifecycleChannels);
        var start = clock.GetTimestamp();
        double Now() => clock.GetElapsedTime(start).TotalMilliseconds;

        CancellationTokenSource? pollLifetime = null;
        Task<JobStatusResponse?>? polling = null;
        void StopPoll()
        {
            pollLifetime?.Cancel();
            pollLifetime?.Dispose();
            if (polling is not null) _ = ObserveDroppedPollAsync(polling);
            pollLifetime = null;
            polling = null;
        }

        try
        {
            stop.ThrowIfCancellationRequested();
            var created = await CreateAsync(command, stallMs, stop).ConfigureAwait(Spawning.Captures);
            report?.Invoke(new JobEvent<T>.Created(created));
            var job = created.JobId;
            double? askAt = Now() + timing.JobSilenceMs;
            double? stallAt = stallMs;
            Task<bool>? ready = null;

            while (true)
            {
                stop.ThrowIfCancellationRequested();

                // One subscription queues all lifecycle channels in arrival order, including
                // frames that arrived before the create reply named the job.
                if (events.Reader.TryRead(out var carried))
                {
                    var heard = Read(carried);
                    if (heard is Heard<Lifecycle>.Refused(var refusal))
                    {
                        // A refused frame names no job: it may be this job's or another's, and it is no word of the job.
                        report?.Invoke(new JobEvent<T>.Refused(refusal.Channel, refusal.Member, refusal.Reason));
                        continue;
                    }
                    if (heard is Heard<Lifecycle>.Delivered(_, var update) && update.Id == job)
                    {
                        StopPoll();
                        var now = Now();
                        stallAt = now + stallMs;
                        switch (update)
                        {
                            case Lifecycle.Progress(var progress):
                                if (progress.Progress is { } detail) report?.Invoke(new JobEvent<T>.Progress(detail));
                                askAt = now + timing.JobSilenceMs;
                                break;
                            case Lifecycle.Failed(var failure):
                                if (failure.WillRetry != true) throw Failed(job, failure.Error, failure.FailureClass);
                                report?.Invoke(new JobEvent<T>.Failed(failure));
                                askAt = null;
                                break;
                            case Lifecycle.Complete(var value):
                                return complete(value);
                        }
                        continue;
                    }
                }

                var elapsed = Now();
                if (stallAt <= elapsed)
                {
                    _ = CancelStalledAsync(job);
                    throw Stalled(job);
                }

                if (polling is { IsCompleted: true })
                {
                    var status = await polling.ConfigureAwait(Spawning.Captures);
                    StopPoll();
                    if (status is not null)
                    {
                        if (status.JobId != job)
                            throw new TransportError(ProtocolFacts.Error(0), "The status is not the followed job's.");
                        switch (status.Status)
                        {
                            case JobStatusResponseStatus.Complete:
                                return complete(JobCompletion.FromStatus(status, resource));
                            case JobStatusResponseStatus.Failed:
                                throw Failed(job, status.Error ?? "Job failed", status.FailureClass);
                            case JobStatusResponseStatus.Cancelled:
                                throw new JobError(ProtocolFacts.JobError("cancelled"), "The job was cancelled.", job);
                        }
                    }
                }

                if (polling is null && askAt <= elapsed)
                {
                    pollLifetime = CancellationTokenSource.CreateLinkedTokenSource(stop);
                    polling = PollAsync(job, pollLifetime.Token);
                    askAt = elapsed + timing.JobStatusPollMs;
                }

                if (ready is { IsCompleted: true })
                {
                    if (!await ready.ConfigureAwait(Spawning.Captures)) throw Closed();
                    ready = null;
                }
                ready ??= Spawning.AsTask(events.Reader.WaitToReadAsync(stop));
                if (ready.IsCompletedSuccessfully)
                {
                    if (!await ready.ConfigureAwait(Spawning.Captures)) throw Closed();
                    ready = null;
                    continue;
                }

                using var timer = CancellationTokenSource.CreateLinkedTokenSource(stop);
                var waits = new List<Task>(3) { ready };
                if (polling is not null) waits.Add(polling);
                var next = Math.Min(stallAt ?? double.PositiveInfinity,
                    (polling is null ? askAt : null) ?? double.PositiveInfinity);
                if (double.IsFinite(next))
                {
                    var delay = TimeSpan.FromMilliseconds(Math.Ceiling(Math.Max(0, next - Now())));
                    waits.Add(Task.Delay(delay, clock, timer.Token));
                }
                await Spawning.WhenAny(waits).ConfigureAwait(Spawning.Captures);
                timer.Cancel();
            }
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested && closed.IsCancellationRequested)
        {
            throw Closed();
        }
        finally
        {
            StopPoll();
            lifetime.Cancel();
        }
    }

    private async Task<JobCreatedResultResponse> CreateAsync(JobCreateCommand command, int? stallMs, CancellationToken cancellation)
    {
        using var deadline = new CancellationTokenSource(
            stallMs is int duration ? TimeSpan.FromMilliseconds(duration) : Timeout.InfiniteTimeSpan, clock);
        using var creating = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token, cancellation);
        try
        {
            return (await wire.RequestAsync(BusOperations.JobCreate, command, cancellation: creating.Token)
                .ConfigureAwait(Spawning.Captures)).Response;
        }
        catch (OperationCanceledException) when (deadline.IsCancellationRequested && !cancellation.IsCancellationRequested)
        {
            throw Stalled(null);
        }
    }

    private async Task<JobStatusResponse?> PollAsync(JobId job, CancellationToken cancellation)
    {
        try { return await jobs.StatusAsync(job, cancellation).ConfigureAwait(Spawning.Captures); }
        catch (Exception error) when (error is BusRequestError or TransportError or OperationCanceledException)
        {
            return null;
        }
    }

    private async Task CancelStalledAsync(JobId job)
    {
        try { await jobs.CancelAsync(job, closed).ConfigureAwait(Spawning.Captures); }
        catch (Exception error) when (error is BusRequestError or TransportError or OperationCanceledException)
        {
            // The local stall is terminal even when the cancellation request cannot be delivered.
        }
    }

    /// <summary>What a frame of a job's lifecycle says of its job, read as its channel types it; or, in its place, the
    /// refusal of a frame refused.</summary>
    private static Heard<Lifecycle> Read(Carried carried)
    {
        if (carried.Channel == BusChannels.JobReportProgress.Name) return Said<JobReportProgressCommand>(carried, progress => new Lifecycle.Progress(progress));
        if (carried.Channel == BusChannels.JobFail.Name) return Said<JobFailCommand>(carried, failure => new Lifecycle.Failed(failure));
        return Said<JobCompleteCommand>(carried, completion => new Lifecycle.Complete(completion));
    }

    private static Heard<Lifecycle> Said<TPayload>(Carried carried, Func<TPayload, Lifecycle> said) where TPayload : class =>
        Bus.HeardOf<TPayload>(carried) switch
        {
            Heard<TPayload>.Delivered delivered => new Heard<Lifecycle>.Delivered(delivered.Received, said(delivered.Payload)),
            Heard<TPayload>.Refused refused => new Heard<Lifecycle>.Refused(refused.Refusal),
        };

    private static JobError Failed(JobId job, string message, FailureClass? classification) =>
        new(ProtocolFacts.JobError("failed"), message, job, classification);

    private static JobError Stalled(JobId? job) =>
        new(ProtocolFacts.JobError("stalled"), "The job stalled without an update.", job);

    private static BusRequestError Closed() => new(ProtocolFacts.BusError("closed"), "The client closed while following a job.");

    private static async Task ObserveDroppedPollAsync(Task poll) => await poll.ConfigureAwait(Spawning.Options(ConfigureAwaitOptions.SuppressThrowing));

    private abstract record Lifecycle(JobId Id)
    {
        internal sealed record Progress(JobReportProgressCommand Value) : Lifecycle(Value.JobId);
        internal sealed record Failed(JobFailCommand Value) : Lifecycle(Value.JobId);
        internal sealed record Complete(JobCompleteCommand Value) : Lifecycle(JobCompletion.Id(Value));
    }
}
