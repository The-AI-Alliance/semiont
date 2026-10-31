package semiont.state

import semiont.Delegation
import semiont.JobAttemptFailed
import semiont.JobCompleted
import semiont.JobCreated
import semiont.JobProgressed
import semiont.SemiontClient
import semiont.StateUnit
import semiont.errors.SemiontError
import semiont.identifiers.JobId
import semiont.transport.Variable
import semiont.transport.Watched
import semiont.types.GenerationJobParams
import semiont.types.JobProgress
import semiont.types.YieldJobCompleteCommand
import semiont.types.YieldJobDone

/**
 * Generation, as state: whether a resource is being generated, the job's id
 * and progress, and what the finished run produced. The display it feeds
 * stays once the run is over: the progress and the outcome are there until
 * they are dismissed, or until the next run begins. A cancelled run's progress
 * stays too, though it made nothing. A run that fails, or stalls, clears its
 * progress and is no longer generating. Why a run ended without a result is
 * held with the rest. A stall is said nowhere else. `locale` is the language
 * a generation is written in when its request states none: BCP 47.
 */
public class YieldStateUnit(private val client: SemiontClient, private val locale: String) : StateUnit {
    private val generating = Variable(false)
    private val progressing = Variable<JobProgress?>(null)
    private val produced = Variable<YieldJobDone?>(null)
    private val failing = Variable<SemiontError?>(null)
    private val job = Variable<JobId?>(null)
    private val tasks = Tasks(client.links.scope.coroutineContext)

    @Volatile
    private var closed = false

    /** Whether a run is under way: from its first progress to its end. */
    public val isGenerating: Watched<Boolean> = generating.reading()

    /** The progress of the run under way, or of the last one until it is dismissed. */
    public val progress: Watched<JobProgress?> = progressing.reading()

    /** What the last finished run produced; none while one runs, and none once dismissed. */
    public val outcome: Watched<YieldJobDone?> = produced.reading()

    /** Why the last run ended without a result: it failed, stalled or was cancelled. None while one runs, after one that completed, and once dismissed. */
    public val failure: Watched<SemiontError?> = failing.reading()

    /** The generation job's id, from the queue's answer to its creation to its end: what `client.job.cancel` names. */
    public val jobId: Watched<JobId?> = job.reading()

    /** Generate a resource from a gathered context, as `client.yield.delegate` does. It is written in this unit's locale when `params` states no language. */
    @JvmOverloads
    public fun generate(params: GenerationJobParams, stallDeadlineMs: Long? = null) {
        if (closed) return
        progressing.set(null)
        produced.set(null)
        failing.set(null)
        job.set(null)
        val written = if (params.language.isNullOrEmpty()) params.copy(language = locale) else params
        val run = client.yield.delegate(written, stallDeadlineMs)
        tasks.run { follow(run) }
    }

    /** Clear the display of a run: its progress, its outcome and why it failed. */
    public fun dismissProgress() {
        if (closed) return
        progressing.set(null)
        produced.set(null)
        failing.set(null)
    }

    private suspend fun follow(run: Delegation<YieldJobCompleteCommand>) {
        // This job's id. At the job's end it is let go only while it is still the one held: a run begun later replaces it.
        var created: JobId? = null
        try {
            run.collect { event ->
                when (event) {
                    is JobCreated -> {
                        job.set(event.data.jobId)
                        created = event.data.jobId
                    }
                    is JobProgressed -> {
                        progressing.set(event.data)
                        generating.set(true)
                    }
                    is JobCompleted -> (event.data.result as? YieldJobDone)?.let(produced::set)
                    // An attempt that failed and will be tried again: the run is not over.
                    is JobAttemptFailed -> Unit
                }
            }
        } catch (failure: SemiontError) {
            // Why it ended is said before the end itself. A cancelled run's progress stays.
            failing.set(failure)
            if (!cancelled(failure)) progressing.set(null)
        }
        generating.set(false)
        if (created != null && job.value == created) job.set(null)
    }

    /** Stop following: the run under way is abandoned, and every state ends. */
    override fun close() {
        closed = true
        tasks.stop()
        generating.end()
        progressing.end()
        produced.end()
        failing.end()
        job.end()
    }
}
