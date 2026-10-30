@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.jobs

import semiont.errors.BusRequestErrorCode
import semiont.identifiers.JobId
import semiont.types.JobType
import java.time.Instant

/**
 * A claim that was refused for a reason other than "nothing pending". `code`
 * is the code the reply was given, or none when the refusal was the worker's
 * own: a reply that names no job, or a claim that could not be sent.
 * `bus.none-pending` is never one: an empty queue is no fault.
 * `bus.unauthorized` means this credential cannot claim, and will not be able
 * to later.
 */
public class ClaimRefusal internal constructor(
    public val code: BusRequestErrorCode?,
    public val message: String,
) {
    override fun toString(): String = "ClaimRefusal(${code?.code}, $message)"
}

/** The job a worker holds, as its vitals name it, and since when. */
public class ActiveJob internal constructor(
    @get:JvmExposeBoxed public val jobId: JobId,
    public val jobType: JobType,
    public val since: Instant,
)

/**
 * What a worker can say of itself at any moment (WORKER-CONTRACT V1).
 * `lastQueuedEventAt` is any `job:queued` received, matching or not: on an
 * idle stack with an empty queue it stands still by design. `lastActivityAt`
 * (a claim, a progress report, a checkpoint, a settle) is the liveness of the
 * work, and what the stall rule reads; `lastFinishedAt` the last settle,
 * whatever its outcome.
 */
public class WorkerVitals internal constructor(
    public val lastQueuedEventAt: Instant?,
    public val lastClaimAt: Instant?,
    public val lastFinishedAt: Instant?,
    public val lastActivityAt: Instant?,
    public val activeJob: ActiveJob?,
    public val jobsCompleted: Long,
)

/** A held job that showed no activity for `thresholdMs` (WORKER-CONTRACT V2). What its host does then is the host's. */
public class HeldJobStall internal constructor(
    @get:JvmExposeBoxed public val jobId: JobId,
    public val jobType: JobType,
    public val heldSince: Instant,
    public val lastActivityAt: Instant,
    public val silentForMs: Long,
    public val thresholdMs: Long,
)
