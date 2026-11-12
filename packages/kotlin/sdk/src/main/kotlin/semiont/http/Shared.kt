package semiont.http

import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.selects.select
import java.util.concurrent.CountDownLatch

/**
 * What this renewal, which several callers wait on, gives, or throws; null at once when its owner closes, which
 * completes `closed`. A waiter that is cancelled is cancelled alone: the renewal goes on for the others. The close
 * gives each waiter no token, as when the issuer gives none, rather than a cancellation none of them had, whether
 * the close ended the renewal or lets it run to its end.
 */
internal suspend fun <T> Deferred<T>.answer(closed: Job): T? = select<T?> {
    closed.onJoin { null }
    onAwait { it }
}

/** Wait, on this thread, until `job` has ended. */
internal fun waitFor(job: Job) {
    val stopped = CountDownLatch(1)
    job.invokeOnCompletion { stopped.countDown() }
    stopped.await()
}
