using Semiont.Errors;
using Semiont.Identifiers;
using Semiont.Http;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont.Namespaces;

public sealed class JobNamespace
{
    private readonly Bus wire;
    private readonly EventBus bus;
    private readonly HttpTransport transport;
    private readonly TimeProvider clock;
    private readonly CancellationToken closed;

    internal JobNamespace(Bus wire, EventBus bus, HttpTransport transport)
    {
        this.wire = wire;
        this.bus = bus;
        this.transport = transport;
        clock = transport.Clock;
        closed = transport.Closed;
    }

    public Claims Claim(IReadOnlyList<JobFilter> accepts) => new(transport, wire, accepts);

    /// <summary>Observes queued jobs. Wire announcements require a transport subscribed to this channel.</summary>
    public IAsyncEnumerable<Heard<JobQueuedEvent>> Queued(CancellationToken cancellation = default) =>
        bus.Frames(BusChannels.JobQueued, cancellation: cancellation);

    public IAsyncEnumerable<Heard<JobReportProgressCommand>> Progress(CancellationToken cancellation = default) =>
        bus.Frames(BusChannels.JobReportProgress, cancellation: cancellation);

    public IAsyncEnumerable<Heard<JobCompleteCommand>> Complete(CancellationToken cancellation = default) =>
        bus.Frames(BusChannels.JobComplete, cancellation: cancellation);

    public IAsyncEnumerable<Heard<JobFailCommand>> Fail(CancellationToken cancellation = default) =>
        bus.Frames(BusChannels.JobFail, cancellation: cancellation);

    public async Task<JobStatusResponse> StatusAsync(JobId jobId, CancellationToken cancellation = default) =>
        (await wire.RequestAsync(BusOperations.JobStatusRequested, new JobStatusRequest { JobId = jobId },
            cancellation: cancellation).ConfigureAwait(false)).Response;

    /// <summary>Reports whether the queue accepted cancellation of the job.</summary>
    public async Task<bool> CancelAsync(JobId jobId, CancellationToken cancellation = default) =>
        (await wire.RequestAsync(BusOperations.JobCancelRequested, new JobCancelRequest { JobId = jobId },
            cancellation: cancellation).ConfigureAwait(false)).Response.Cancelled;

    /// <summary>Returns the first terminal status, reporting each status received along the way.</summary>
    public async Task<JobStatusResponse> PollUntilCompleteAsync(JobId jobId, int intervalMs = 1000, int timeoutMs = 60000,
        Action<JobStatusResponse>? onStatus = null, CancellationToken cancellation = default)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(intervalMs);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(timeoutMs);
        var interval = TimeSpan.FromMilliseconds(intervalMs);
        using var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(timeoutMs), clock);
        using var waiting = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token, closed, cancellation);
        try
        {
            while (true)
            {
                waiting.Token.ThrowIfCancellationRequested();
                var status = await StatusAsync(jobId, waiting.Token).ConfigureAwait(false);
                waiting.Token.ThrowIfCancellationRequested();
                onStatus?.Invoke(status);
                if (status.Status is not (JobStatusResponseStatus.Pending or JobStatusResponseStatus.Running)) return status;
                await Task.Delay(interval, clock, waiting.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested && closed.IsCancellationRequested)
        {
            throw new BusRequestError(ProtocolFacts.BusError("closed"), "The client closed while polling the job");
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested && deadline.IsCancellationRequested)
        {
            throw new BusRequestError(ProtocolFacts.BusError("timeout"), "Job polling timed out");
        }
    }
}
