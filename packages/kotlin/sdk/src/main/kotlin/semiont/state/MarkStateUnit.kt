@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.state

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import semiont.Delegation
import semiont.JobAttemptFailed
import semiont.JobCompleted
import semiont.JobCreated
import semiont.JobEvent
import semiont.JobProgressed
import semiont.SemiontClient
import semiont.StateUnit
import semiont.Timings
import semiont.bus.decoded
import semiont.channels.Channels
import semiont.errors.SemiontError
import semiont.identifiers.JobId
import semiont.identifiers.ResourceId
import semiont.transport.Frame
import semiont.transport.Variable
import semiont.transport.Watched
import semiont.types.AnnotationSelector
import semiont.types.AnnotationTarget
import semiont.types.AssessingJobParams
import semiont.types.CommentingJobParams
import semiont.types.CreateAnnotationRequest
import semiont.types.HighlightingJobParams
import semiont.types.JobProgress
import semiont.types.LinkingJobParams
import semiont.types.MarkDelegateTimeoutEvent
import semiont.types.MarkJobCompleteCommand
import semiont.types.MarkJobParams
import semiont.types.MarkSubmitEvent
import semiont.types.Motivation
import semiont.types.ResourceErrorEvent
import semiont.types.TaggingJobParams

/** An annotation being composed: where it is, and why it is made. Its selector is what `client.mark.submit` takes. */
public data class PendingAnnotation(
    public val selector: AnnotationSelector,
    public val motivation: Motivation,
)

/** The motivation a mark job's parameters are for. */
private fun motivationOf(params: MarkJobParams): Motivation = when (params) {
    is HighlightingJobParams -> Motivation.Highlighting
    is CommentingJobParams -> Motivation.Commenting
    is AssessingJobParams -> Motivation.Assessing
    is LinkingJobParams -> Motivation.Linking
    is TaggingJobParams -> Motivation.Tagging
}

/** What the reading of a delegated job gives its follower: an event, or the job's end, with the failure it ended on. */
private sealed interface Heard {
    class Event(val event: JobEvent<MarkJobCompleteCommand>) : Heard

    class Ended(val failure: SemiontError?) : Heard
}

/**
 * Marking, as one resource's state: the annotation being composed, and the
 * delegated job that is running.
 *
 * A selection (`client.mark.request`) becomes the annotation pending.
 * Submitting it (`client.mark.submit`) creates it, and it stops being pending
 * when the knowledge base says it is recorded; a creation that fails leaves it
 * pending and says `mark:create-error` on the client's own bus.
 * `cancelPending` drops it. A request and a submission are signals that name
 * the resource they are for, and a unit acts only on its own; a delegation, a
 * cancel and a dismissal are asked of the unit itself. So several units over
 * one client, one per open resource, do not answer for each other.
 *
 * `requestDelegate` starts the `mark` job of the parameters it is given, for
 * this unit's resource. The motivation those parameters state is held while it
 * runs, and its progress as it comes, with the motivation that progress is of.
 * A finished job's progress stays until it is dismissed or the next one
 * begins, and so does a cancelled one's: its commits stand. One that fails
 * clears it. Why a job ended without completing is held until the progress is
 * dismissed or the next job begins. The job's id is held from the queue's
 * answer to its creation to the job's end. A job that says nothing for
 * `Timings.DELEGATE_SILENCE_MS` has gone quiet, which is not over: the unit
 * says so once (`mark:delegate-timeout`) and keeps following it, so a
 * completion that comes later still ends it.
 */
public class MarkStateUnit @JvmExposeBoxed constructor(private val client: SemiontClient, private val resourceId: ResourceId) : StateUnit {
    private val pending = Variable<PendingAnnotation?>(null)
    private val delegating = Variable<Motivation?>(null)
    private val progressing = Variable<JobProgress?>(null)
    private val progressingFor = Variable<Motivation?>(null)
    private val failing = Variable<SemiontError?>(null)
    private val job = Variable<JobId?>(null)
    private val tasks = Tasks(client.links.scope.coroutineContext)

    @Volatile
    private var closed = false

    /** The annotation being composed, or none. */
    public val pendingAnnotation: Watched<PendingAnnotation?> = pending.reading()

    /** The motivation of the delegated job that is running, or none. */
    public val delegatingMotivation: Watched<Motivation?> = delegating.reading()

    /** The progress of the delegated job that is running, or of the last one until it is dismissed. */
    public val progress: Watched<JobProgress?> = progressing.reading()

    /** The motivation of the run whose progress `progress` holds, until the progress is dismissed or cleared by a failure. */
    public val progressMotivation: Watched<Motivation?> = progressingFor.reading()

    /** Why the last delegated job ended without completing, until it is dismissed or the next job begins. */
    public val failure: Watched<SemiontError?> = failing.reading()

    /** The delegated job's id, from the queue's answer to its creation to its end: what `client.job.cancel` names. */
    public val jobId: Watched<JobId?> = job.reading()

    init {
        // One reader of every signal it hears, taken now, so what is said from here on is acted on in the order it was said.
        val heard = client.bus.framesAmong(listOf(Channels.MARK_REQUESTED.name, Channels.MARK_SUBMIT.name))
        tasks.run {
            heard.collect { frame ->
                try {
                    heard(frame)
                } catch (_: IllegalArgumentException) {
                    // A frame that is not its channel's is nobody's to act on.
                }
            }
        }
    }

    /** Delegate the annotating of this unit's resource, as the `mark` job of `params`: what `client.mark.delegate` takes. */
    public fun requestDelegate(params: MarkJobParams) {
        if (closed) return
        val motivation = motivationOf(params)
        delegating.set(motivation)
        progressing.set(null)
        progressingFor.set(motivation)
        failing.set(null)
        job.set(null)
        val run = client.mark.delegate(resourceId, params)
        tasks.run { follow(run, motivation) }
    }

    /** Drop the annotation that is pending. */
    public fun cancelPending() {
        if (!closed) pending.set(null)
    }

    /** Clear the display of a delegated job: its progress, the motivation that progress is of, and why it ended. */
    public fun dismissProgress() {
        if (closed) return
        progressing.set(null)
        progressingFor.set(null)
        failing.set(null)
    }

    private fun heard(frame: Frame) {
        when (frame.channel) {
            Channels.MARK_REQUESTED.name -> {
                val request = decoded(Channels.MARK_REQUESTED, frame.payload)
                if (request.source == resourceId) pending.set(PendingAnnotation(request.selector, request.motivation))
            }
            Channels.MARK_SUBMIT.name -> {
                val submission = decoded(Channels.MARK_SUBMIT, frame.payload)
                if (submission.source == resourceId) tasks.run { create(submission) }
            }
        }
    }

    /**
     * The annotation stops being pending here, when its own creation is
     * recorded, and not on any creation's reply: a reply does not say which
     * resource it was for, so another viewer's would drop this one's selection.
     */
    private suspend fun create(submission: MarkSubmitEvent) {
        val target = AnnotationTarget(source = resourceId, selector = submission.selector)
        try {
            client.mark.annotation(CreateAnnotationRequest(motivation = submission.motivation, target = target, body = submission.body))
        } catch (failure: SemiontError) {
            client.bus.publish(Channels.MARK_CREATE_ERROR, ResourceErrorEvent(resourceId = resourceId, message = failure.message ?: ""), null, null)
            return
        }
        pending.set(null)
    }

    private suspend fun follow(run: Delegation<MarkJobCompleteCommand>, motivation: Motivation): Unit = coroutineScope {
        // The job is read on a task of its own: a silence gives up waiting for its next event, never the reading,
        // since a delegation whose reader is cancelled is abandoned, and a quiet job is still followed.
        val heard = Channel<Heard>(Channel.UNLIMITED)
        launch {
            val ended = try {
                run.collect { heard.send(Heard.Event(it)) }
                null
            } catch (failure: SemiontError) {
                failure
            }
            heard.send(Heard.Ended(ended))
        }
        // This job's id. At the job's end it is let go only while it is still the one held: a job delegated later replaces it.
        var created: JobId? = null
        // Whether the next silence is still to be said. It is said once, and again only after the job has said something.
        var listening = true
        var ended: Heard.Ended? = null
        while (ended == null) {
            val next = if (listening) withTimeoutOrNull(Timings.DELEGATE_SILENCE_MS) { heard.receive() } else heard.receive()
            when (next) {
                null -> {
                    listening = false
                    goneQuiet(motivation)
                }
                is Heard.Ended -> ended = next
                is Heard.Event -> {
                    listening = true
                    when (val event = next.event) {
                        is JobCreated -> {
                            job.set(event.data.jobId)
                            created = event.data.jobId
                        }
                        is JobProgressed -> progressing.set(event.data)
                        // An attempt that will be tried again, or the completion, which the end follows.
                        is JobAttemptFailed, is JobCompleted -> Unit
                    }
                }
            }
        }
        ended.failure?.let { failure ->
            // Why it ended is said before the end itself. A cancelled job's commits stand, and its display stays to say so.
            failing.set(failure)
            if (!cancelled(failure)) {
                progressing.set(null)
                progressingFor.set(null)
            }
        }
        delegating.set(null)
        if (created != null && job.value == created) job.set(null)
    }

    /** The job is still running as far as anyone here knows, so its motivation stays; a display with no progress is given one. */
    private fun goneQuiet(motivation: Motivation) {
        if (progressing.value == null) progressing.set(JobProgress(percentage = 0.0))
        client.bus.publish(Channels.MARK_DELEGATE_TIMEOUT, MarkDelegateTimeoutEvent(resourceId = resourceId, motivation = motivation), null, null)
    }

    /** Stop marking: the job followed is abandoned, and every state ends. */
    override fun close() {
        closed = true
        tasks.stop()
        pending.end()
        delegating.end()
        progressing.end()
        progressingFor.end()
        failing.end()
        job.end()
    }
}
