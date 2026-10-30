@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package semiont.namespaces

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.channels.produce
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.onTimeout
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.supervisorScope
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import semiont.Delegation
import semiont.JobAttemptFailed
import semiont.JobCompleted
import semiont.JobCreated
import semiont.JobEvent
import semiont.JobProgressed
import semiont.Running
import semiont.bus.Operations
import semiont.bus.decoded
import semiont.bus.lacks
import semiont.channels.Channels
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode
import semiont.errors.JobError
import semiont.errors.JobErrorCode
import semiont.errors.SemiontError
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.identifiers.JobId
import semiont.identifiers.ResourceId
import semiont.telemetry.callersTrace
import semiont.transport.Frame
import semiont.types.JobCancelRequest
import semiont.types.JobCompleteCommand
import semiont.types.JobCreateCommand
import semiont.types.JobCreatedResult
import semiont.types.JobFailCommand
import semiont.types.JobReportProgressCommand
import semiont.types.JobStatusRequest
import semiont.types.JobStatusResponse
import semiont.types.JobStatusResponseStatus
import semiont.types.JobStoredResult
import semiont.types.MarkJobCompleteCommand
import semiont.types.MarkJobCreateCommand
import semiont.types.YieldJobCompleteCommand
import semiont.types.YieldJobCreateCommand
import semiont.types.wireJson

/** The channels of a job's lifecycle, read as one so its frames are heard in the order they were published. */
private val LIFECYCLE = listOf(Channels.JOB_REPORT_PROGRESS.name, Channels.JOB_COMPLETE.name, Channels.JOB_FAIL.name)

/** The verb whose job a creation asks for, as the wire spells it. */
private val JobCreateCommand.delegated: String
    get() = when (this) {
        is MarkJobCreateCommand -> jobType.value
        is YieldJobCreateCommand -> jobType.value
    }

private val JobCompleteCommand.job: JobId
    get() = when (this) {
        is MarkJobCompleteCommand -> jobId
        is YieldJobCompleteCommand -> jobId
    }

private val JobCompleteCommand.verb: String
    get() = when (this) {
        is MarkJobCompleteCommand -> jobType.value
        is YieldJobCompleteCommand -> jobType.value
    }

/** A frame of some job's lifecycle, read as its channel's. One that is not its channel's is nobody's to act on. */
private fun saidIn(frame: Frame): Any? = try {
    when (frame.channel) {
        Channels.JOB_REPORT_PROGRESS.name -> decoded(Channels.JOB_REPORT_PROGRESS, frame.payload)
        Channels.JOB_COMPLETE.name -> decoded(Channels.JOB_COMPLETE, frame.payload)
        Channels.JOB_FAIL.name -> decoded(Channels.JOB_FAIL, frame.payload)
        else -> null
    }
} catch (_: IllegalArgumentException) {
    null
}

/** The job a frame of the lifecycle is of. */
private fun jobOf(said: Any): JobId? = when (said) {
    is JobReportProgressCommand -> said.jobId
    is JobFailCommand -> said.jobId
    is JobCompleteCommand -> said.job
    else -> null
}

/**
 * Create a job and follow it to the completion its verb's jobs give
 * (docs/protocol/JOBS.md, Following a job). `completion` is that
 * completion's class; `resourceId` is the resource the job is about, for a
 * completion learned from the job's status; `stallMs` is how long the job
 * may say nothing before its follower gives up on it, when it gives up at all.
 */
internal fun <C : JobCompleteCommand> follow(
    links: Links,
    create: JobCreateCommand,
    completion: Class<C>,
    resourceId: ResourceId,
    stallMs: Long?,
): Delegation<C> = Delegation(Running(links.scope) { report -> Follower(links, create, completion, resourceId, stallMs, report).followed() })

/** How the follower's wait ended: what came, of the three it waits on, or its due time. */
private sealed interface Woke {
    class Created(val result: JobCreatedResult) : Woke

    class Arrived(val frame: Frame?) : Woke

    data object Answered : Woke

    data object Due : Woke
}

/**
 * The follower of one job. It listens before it creates the job, so a frame
 * of the job read beside the reply that names it is held, and the job's are
 * then handled in the order they came. Having heard nothing of its job for
 * the client's `jobSilenceMs`, it asks for the job's status, and again every
 * `jobStatusPollMs`, until the job says something or its status is an end.
 */
private class Follower<C : JobCompleteCommand>(
    private val links: Links,
    private val create: JobCreateCommand,
    private val completion: Class<C>,
    private val resourceId: ResourceId,
    private val stallMs: Long?,
    private val report: (JobEvent<C>) -> Unit,
) {
    suspend fun followed(): JobEvent<C> = supervisorScope { within(this) }

    private fun now(): Long = System.nanoTime() / 1_000_000

    private suspend fun within(scope: CoroutineScope): JobEvent<C> {
        val silence = links.timing.jobSilenceMs
        val poll = links.timing.jobStatusPollMs
        val frames = links.own.framesAmong(LIFECYCLE)
        val arriving: ReceiveChannel<Frame> = scope.produce(capacity = Channel.UNLIMITED) { frames.collect { send(it) } }
        var creating: Deferred<JobCreatedResult>? = scope.async { links.request(Operations.JOB_CREATE, create) }
        var asking: Deferred<JobStatusResponse>? = null
        var jobId: JobId? = null
        var held = mutableListOf<Any>()
        var askAt: Long? = null
        var stallAt: Long? = stallMs?.let { now() + it }
        try {
            while (true) {
                var at = now()
                if (stallMs != null && stallAt != null && at >= stallAt) throw stalled(jobId)
                val due = listOfNotNull(askAt, stallAt).minOrNull()
                val woke = select {
                    creating?.onAwait { Woke.Created(it) }
                    arriving.onReceiveCatching { Woke.Arrived(it.getOrNull()) }
                    asking?.onJoin { Woke.Answered }
                    if (due != null) onTimeout(maxOf(due - at, 0)) { Woke.Due }
                }
                at = now()
                val heard = mutableListOf<Any>()
                when (woke) {
                    is Woke.Created -> {
                        creating = null
                        jobId = woke.result.response.jobId
                        // Ahead of the frames held for it: the job's id is the first thing its follower gives.
                        report(JobCreated(woke.result.response))
                        askAt = at + silence
                        heard.addAll(held)
                        held = mutableListOf()
                    }
                    is Woke.Arrived -> {
                        val frame = woke.frame ?: throw BusRequestError(BusRequestErrorCode.Closed, "The client closed while it was following a job")
                        saidIn(frame)?.let { said -> if (jobId == null) held += said else heard += said }
                    }
                    Woke.Answered -> {
                        val answered = checkNotNull(asking)
                        asking = null
                        when (val failure = answered.getCompletionExceptionOrNull()) {
                            null -> ended(answered.getCompleted())?.let { return it }
                            // A status that could not be had is asked for again at the next poll.
                            is SemiontError -> Unit
                            else -> throw failure
                        }
                    }
                    Woke.Due -> Unit
                }
                val askBy = askAt
                val id = jobId
                if (askBy != null && at >= askBy) {
                    askAt = at + poll
                    if (asking == null && id != null) {
                        asking = scope.async { links.request(Operations.JOB_STATUS_REQUESTED, JobStatusRequest(jobId = id)).response }
                    }
                }
                for (said in heard) {
                    if (jobOf(said) != id) continue
                    when (said) {
                        is JobReportProgressCommand -> {
                            said.progress?.let { report(JobProgressed(it)) }
                            askAt = at + silence
                            stallAt = stallMs?.let { at + it }
                        }
                        is JobFailCommand -> {
                            // Absent reads as final: a follower that ends early is seen, one that never ends is not.
                            if (said.willRetry != true) throw JobError(JobErrorCode.Failed, said.error, said.jobId, said.failureClass)
                            // The queue tries the job again, and the next attempt's first frame starts the silence
                            // again. The setback was heard, so the stall deadline starts again: one left running would
                            // cancel the attempt that is coming.
                            askAt = null
                            stallAt = stallMs?.let { at + it }
                            report(JobAttemptFailed(said))
                        }
                        is JobCompleteCommand -> {
                            // The third thing a job says: that it completed, read as the delegated verb's completion.
                            if (completion.isInstance(said)) return JobCompleted(completion.cast(said))
                            throw TransportError(
                                TransportErrorCode.Error,
                                "The job:complete of job ${said.job.value} is a ${said.verb} job's, and the job delegated is a ${create.delegated} job",
                            )
                        }
                    }
                }
            }
        } finally {
            creating?.cancel()
            asking?.cancel()
            arriving.cancel()
            frames.close()
        }
    }

    /**
     * A stall: the job's cancellation is asked for, as a task of the client's,
     * since the follower ends here and the request must outlive it. A job whose
     * creation was never answered has no id, and there is nothing to cancel.
     */
    private fun stalled(jobId: JobId?): JobError {
        if (jobId != null) {
            links.scope.launch(callersTrace()) {
                try {
                    links.request(Operations.JOB_CANCEL_REQUESTED, JobCancelRequest(jobId = jobId))
                } catch (_: SemiontError) {
                    // A cancellation nobody awaits: its failure is nobody's to hear.
                }
            }
        }
        return JobError(JobErrorCode.Stalled, "The job stalled: nothing was heard of it within ${stallMs}ms", jobId, null)
    }

    /** How a status ends the follower: with the completion it stands for, or with the job's failure. A job not yet ended goes on. */
    private fun ended(status: JobStatusResponse): JobEvent<C>? = when (status.status) {
        JobStatusResponseStatus.Complete -> JobCompleted(learned(status))
        JobStatusResponseStatus.Failed -> throw JobError(JobErrorCode.Failed, status.error ?: "Job failed", status.jobId, status.failureClass)
        // Nothing announces a cancellation: this is where its follower learns of one.
        JobStatusResponseStatus.Cancelled -> throw JobError(JobErrorCode.Cancelled, "The job was cancelled", status.jobId, null)
        JobStatusResponseStatus.Pending, JobStatusResponseStatus.Running -> null
    }

    /**
     * The completion a complete status stands for, read as the delegated
     * verb's. A status states its job's type and a result of any verb's, and
     * not the resource the job is about: what it states is given to the
     * completions' own shape to read, and nothing here says which result is
     * which verb's.
     */
    private fun learned(status: JobStatusResponse): C {
        val stated = mutableMapOf<String, JsonElement>(
            "resourceId" to JsonPrimitive(resourceId.value),
            "jobId" to JsonPrimitive(status.jobId.value),
            "jobType" to JsonPrimitive(status.type.value),
        )
        // A job completed without a result is stored with an empty one: an object that holds nothing.
        status.result?.takeUnless { it == JobStoredResult.Empty }?.let { stated["result"] = wireJson.encodeToJsonElement(JobStoredResult.serializer(), it) }
        val read = try {
            wireJson.decodeFromJsonElement(JobCompleteCommand.serializer(), JsonObject(stated))
        } catch (refused: IllegalArgumentException) {
            val lacking = lacks(refused)?.let { ": it lacks $it" } ?: ""
            throw TransportError(TransportErrorCode.Error, "The status of job ${status.jobId.value} is not a completed ${create.delegated} job's$lacking")
        }
        if (!completion.isInstance(read)) {
            throw TransportError(TransportErrorCode.Error, "The status of job ${status.jobId.value} is a ${read.verb} job's, and the job delegated is a ${create.delegated} job")
        }
        return completion.cast(read)
    }
}
