@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.namespaces

import kotlinx.coroutines.delay
import semiont.Timings
import semiont.bus.Operations
import semiont.bus.Typed
import semiont.channels.Channels
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode
import semiont.identifiers.JobId
import semiont.jobs.Claims
import semiont.types.JobCancelRequest
import semiont.types.JobCompleteCommand
import semiont.types.JobFailCommand
import semiont.types.JobFilter
import semiont.types.JobQueuedEvent
import semiont.types.JobReportProgressCommand
import semiont.types.JobStatusRequest
import semiont.types.JobStatusResponse
import semiont.types.JobStatusResponseStatus
import java.util.concurrent.CompletableFuture
import java.util.function.Consumer

/** Jobs: their lifecycle, their status and their cancellation. */
public class JobNamespace internal constructor(private val links: Links) {
    /** The jobs queued from now on, as this client hears of them. */
    public fun queued(): Typed<JobQueuedEvent> = links.own.frames(Channels.JOB_QUEUED, null)

    /** Each job's progress from now on. */
    public fun progress(): Typed<JobReportProgressCommand> = links.own.frames(Channels.JOB_REPORT_PROGRESS, null)

    /** Each job that completes from now on. */
    public fun complete(): Typed<JobCompleteCommand> = links.own.frames(Channels.JOB_COMPLETE, null)

    /** Each job that fails from now on. */
    public fun fail(): Typed<JobFailCommand> = links.own.frames(Channels.JOB_FAIL, null)

    /**
     * A worker's claims of the jobs `accepts` takes: each job it comes to hold,
     * one at a time, and each claim it was refused
     * (docs/protocol/WORKER-CONTRACT.md). Nothing is claimed until they are
     * first read. A claim waits `jobClaimTimeoutMs` for its answer; a held job
     * silent for `heldJobStallMs` is stalled, looked for every
     * `heldJobStallCheckMs`; each of a commit's requests waits
     * `markCommitTimeoutMs`. The transport's stream names the replies of
     * `job:claim`, `job:queued` and `job:cancel-requested`, and, for a worker
     * that commits, the replies of `mark:commit` and
     * `browse:annotation-requested`.
     */
    @JvmOverloads
    public fun claim(
        accepts: List<JobFilter>,
        jobClaimTimeoutMs: Long = Timings.JOB_CLAIM_TIMEOUT_MS,
        heldJobStallMs: Long = Timings.HELD_JOB_STALL_MS,
        heldJobStallCheckMs: Long = Timings.HELD_JOB_STALL_CHECK_MS,
        markCommitTimeoutMs: Long = Timings.MARK_COMMIT_TIMEOUT_MS,
    ): Claims = Claims(links.transport, accepts, links.scope, links.clock, jobClaimTimeoutMs, heldJobStallMs, heldJobStallCheckMs, markCommitTimeoutMs)

    /** A job's status, asked for now. */
    public suspend fun status(jobId: JobId): JobStatusResponse = links.request(Operations.JOB_STATUS_REQUESTED, JobStatusRequest(jobId = jobId)).response

    /** `status`, for Java. */
    @JvmExposeBoxed
    public fun statusFuture(jobId: JobId): CompletableFuture<JobStatusResponse> = links.future { status(jobId) }

    /**
     * Ask a job's status every `everyMs` until it has ended: the status it
     * ended with. One that has not ended `withinMs` fails as a timeout.
     * `onStatus` is told each status as it is answered.
     */
    public suspend fun pollUntilComplete(jobId: JobId, everyMs: Long, withinMs: Long, onStatus: ((JobStatusResponse) -> Unit)? = null): JobStatusResponse {
        val began = links.clock.markNow()
        while (true) {
            val answered = status(jobId)
            onStatus?.invoke(answered)
            if (answered.status in ENDED) return answered
            if (began.elapsedNow().inWholeMilliseconds > withinMs) throw BusRequestError(BusRequestErrorCode.Timeout, "Job polling timeout after ${withinMs}ms")
            delay(everyMs)
        }
    }

    /** `pollUntilComplete`, for Java. */
    @JvmExposeBoxed
    public fun pollUntilCompleteFuture(jobId: JobId, everyMs: Long, withinMs: Long, onStatus: Consumer<JobStatusResponse>?): CompletableFuture<JobStatusResponse> =
        links.future { pollUntilComplete(jobId, everyMs, withinMs, onStatus?.let { told -> { told.accept(it) } }) }

    /**
     * Cancel a job. A pending job is cancelled outright; a running one is left
     * to its worker, so true means accepted, not stopped. False is a job the
     * queue does not know, or one already over.
     */
    public suspend fun cancel(jobId: JobId): Boolean = links.request(Operations.JOB_CANCEL_REQUESTED, JobCancelRequest(jobId = jobId)).response.cancelled

    /** `cancel`, for Java. */
    @JvmExposeBoxed
    public fun cancelFuture(jobId: JobId): CompletableFuture<Boolean> = links.future { cancel(jobId) }

    private companion object {
        /** The statuses a job ends in. */
        val ENDED = setOf(JobStatusResponseStatus.Complete, JobStatusResponseStatus.Failed, JobStatusResponseStatus.Cancelled)
    }
}
