using System.Runtime.ExceptionServices;
using System.Text.Json;
using Semiont.Errors;
using Semiont.Identifiers;
using Semiont.Namespaces;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont;

internal sealed class JobFollower(Bus wire, EventBus bus, JobNamespace jobs, TimeProvider clock, CancellationToken closed)
{
    private static readonly string[] LifecycleChannels =
        [BusChannels.JobReportProgress.Name, BusChannels.JobFail.Name, BusChannels.JobComplete.Name];
    private static readonly int SilenceMs = ProtocolFacts.Timing("jobSilenceMs").GetInt32();
    private static readonly int PollMs = ProtocolFacts.Timing("jobStatusPollMs").GetInt32();

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
        Task<PollAnswer>? polling = null;
        void StopPoll()
        {
            pollLifetime?.Cancel();
            pollLifetime?.Dispose();
            pollLifetime = null;
            polling = null;
        }

        try
        {
            stop.ThrowIfCancellationRequested();
            var created = await CreateAsync(command, stallMs, stop).ConfigureAwait(false);
            report?.Invoke(new JobEvent<T>.Created(created));
            var job = created.JobId;
            double? askAt = Now() + SilenceMs;
            double? stallAt = stallMs;
            Task<bool>? ready = null;

            while (true)
            {
                stop.ThrowIfCancellationRequested();

                // One subscription queues all lifecycle channels in arrival order, including
                // frames that arrived before the create reply named the job.
                if (events.Reader.TryRead(out var frame) && Read(frame) is { } update && update.Id == job)
                {
                    StopPoll();
                    var now = Now();
                    stallAt = now + stallMs;
                    switch (update)
                    {
                        case Lifecycle.Progress(var progress):
                            if (progress.Progress is { } detail) report?.Invoke(new JobEvent<T>.Progress(detail));
                            askAt = now + SilenceMs;
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

                var elapsed = Now();
                if (stallAt <= elapsed)
                {
                    _ = CancelStalledAsync(job);
                    throw Stalled(job);
                }

                if (polling is { IsCompleted: true })
                {
                    var answer = await polling.ConfigureAwait(false);
                    StopPoll();
                    answer.Error?.Throw();
                    if (answer.Status is { } status)
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
                    askAt = elapsed + PollMs;
                }

                if (ready is { IsCompleted: true })
                {
                    if (!await ready.ConfigureAwait(false)) throw Closed();
                    ready = null;
                }
                ready ??= events.Reader.WaitToReadAsync(stop).AsTask();
                if (ready.IsCompletedSuccessfully)
                {
                    if (!await ready.ConfigureAwait(false)) throw Closed();
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
                await Task.WhenAny(waits).ConfigureAwait(false);
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
                .ConfigureAwait(false)).Response;
        }
        catch (OperationCanceledException) when (deadline.IsCancellationRequested && !cancellation.IsCancellationRequested)
        {
            throw Stalled(null);
        }
    }

    private async Task<PollAnswer> PollAsync(JobId job, CancellationToken cancellation)
    {
        try { return new(await jobs.StatusAsync(job, cancellation).ConfigureAwait(false), null); }
        catch (Exception error) when (error is BusRequestError or TransportError or OperationCanceledException)
        {
            return new(null, null);
        }
        catch (Exception error) { return new(null, ExceptionDispatchInfo.Capture(error)); }
    }

    private async Task CancelStalledAsync(JobId job)
    {
        try { await jobs.CancelAsync(job, closed).ConfigureAwait(false); }
        catch (Exception error) when (error is BusRequestError or TransportError or OperationCanceledException)
        {
            // The local stall is terminal even when the cancellation request cannot be delivered.
        }
    }

    private static Lifecycle? Read(ReceivedBusFrame received)
    {
        var frame = received.Frame;
        try
        {
            if (frame.Channel == BusChannels.JobReportProgress.Name) return new Lifecycle.Progress(Bus.Decode<JobReportProgressCommand>(frame.Payload));
            if (frame.Channel == BusChannels.JobFail.Name) return new Lifecycle.Failed(Bus.Decode<JobFailCommand>(frame.Payload));
            return new Lifecycle.Complete(Bus.Decode<JobCompleteCommand>(frame.Payload));
        }
        catch (JsonException) { return null; }
    }

    private static JobError Failed(JobId job, string message, FailureClass? classification) =>
        new(ProtocolFacts.JobError("failed"), message, job, classification);

    private static JobError Stalled(JobId? job) =>
        new(ProtocolFacts.JobError("stalled"), "The job stalled without an update.", job);

    private static BusRequestError Closed() => new(ProtocolFacts.BusError("closed"), "The client closed while following a job.");

    private sealed record PollAnswer(JobStatusResponse? Status, ExceptionDispatchInfo? Error);

    private abstract record Lifecycle(JobId Id)
    {
        internal sealed record Progress(JobReportProgressCommand Value) : Lifecycle(Value.JobId);
        internal sealed record Failed(JobFailCommand Value) : Lifecycle(Value.JobId);
        internal sealed record Complete(JobCompleteCommand Value) : Lifecycle(JobCompletion.Id(Value));
    }
}
