@file:OptIn(kotlinx.coroutines.ExperimentalForInheritanceCoroutinesApi::class)

package semiont

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.jdk9.asPublisher
import semiont.types.JobCompleteCommand
import semiont.types.JobCreatedResultResponse
import semiont.types.JobFailCommand
import semiont.types.JobProgress
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Flow.Publisher

/**
 * What a followed job reports, and how it ends, `C` being the completion its
 * verb's jobs give. As JSON it is `{"kind": "progress", "data": …}`, the same
 * event in every SDK.
 */
public sealed interface JobEvent<out C : JobCompleteCommand> {
    /** Which event it is, as every SDK spells it. */
    public val kind: String
}

/** The queue's answer to the job's creation, naming the job. A follower's first value. */
public data class JobCreated(public val data: JobCreatedResultResponse) : JobEvent<Nothing> {
    override val kind: String get() = "created"
}

/** The job's progress. */
public data class JobProgressed(public val data: JobProgress) : JobEvent<Nothing> {
    override val kind: String get() = "progress"
}

/** An attempt failed and the queue will try again. The job is not over. */
public data class JobAttemptFailed(public val data: JobFailCommand) : JobEvent<Nothing> {
    override val kind: String get() = "failed"
}

/** The job completed, with the completion its verb's jobs give. A follower's last value. */
public data class JobCompleted<out C : JobCompleteCommand>(public val data: C) : JobEvent<C> {
    override val kind: String get() = "complete"
}

/**
 * A job another party does (`mark.delegate`, `yield.delegate`), consumed one
 * way, once: awaited, it gives the job's completion; collected, it gives every
 * event of the job, the completion's the last of them, and ends. A job that
 * does not complete is a failure, thrown where the completion would have been
 * given. Nothing is sent until it is first awaited or collected, and its
 * caller abandons it by cancelling what awaits or collects it: the job goes
 * on, and is followed no more.
 */
public class Delegation<C : JobCompleteCommand> internal constructor(private val following: Running<JobEvent<C>>) : Flow<JobEvent<C>> {
    /** The job's completion. */
    public suspend fun await(): C = completionOf(following.await())

    /** `await`, for Java: cancelling the future abandons the following. */
    public fun awaitFuture(): CompletableFuture<C> = following.awaitFuture().thenApply(::completionOf)

    private fun completionOf(last: JobEvent<C>): C = when (last) {
        is JobCompleted -> last.data
        else -> throw IllegalStateException("a delegated job ended on a ${last.kind} event, not on its completion")
    }

    override suspend fun collect(collector: FlowCollector<JobEvent<C>>): Unit = following.collect(collector)

    /** Every event of the job, the completion's last, for Java. */
    public fun asPublisher(): Publisher<JobEvent<C>> = following.asPublisher()
}
