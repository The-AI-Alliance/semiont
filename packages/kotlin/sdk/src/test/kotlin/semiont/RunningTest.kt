package semiont

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode
import semiont.types.MarkJobCompleteCommand
import java.util.concurrent.CompletableFuture

/** A long-running operation: its reports, its final value, consumed once, and abandoned by its caller. */
class RunningTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Test
    fun nothingIsDoneUntilItIsFirstAwaitedOrCollected() = runBlocking {
        var started = false
        val running = Running(scope) { started = true; "done" }
        delay(50)
        assertFalse(started)
        assertEquals("done", running.await())
        assertTrue(started)
    }

    @Test
    fun collectedItGivesEveryReportAndThenItsFinalValue() = runBlocking {
        val running = Running<String>(scope) { report ->
            report("a")
            report("b")
            "final"
        }
        assertEquals(listOf("a", "b", "final"), withTimeout(5_000) { running.toList() })
    }

    @Test
    fun itIsConsumedOnce() = runBlocking {
        val running = Running(scope) { "done" }
        running.await()
        assertThrows(IllegalStateException::class.java) { runBlocking { running.await() } }
        assertThrows(IllegalStateException::class.java) { runBlocking { running.toList() } }
        Unit
    }

    @Test
    fun abandoningItEndsTheWork() = runBlocking {
        val ended = CompletableDeferred<Unit>()
        val running = Running<String>(scope) {
            try {
                awaitCancellation()
            } finally {
                ended.complete(Unit)
            }
        }
        val waiting = launch { running.await() }
        delay(50)
        waiting.cancel()
        withTimeout(5_000) { ended.await() }
    }

    @Test
    fun cancellingTheFutureOfItsOutcomeEndsTheWorkOfARunningOperationAndOfADelegation() = runBlocking {
        suspend fun endsTheWork(whose: String, awaiting: (Running<JobEvent<MarkJobCompleteCommand>>) -> CompletableFuture<*>) {
            val began = CompletableDeferred<Unit>()
            val ended = CompletableDeferred<Unit>()
            val following = Running<JobEvent<MarkJobCompleteCommand>>(scope) {
                began.complete(Unit)
                try {
                    awaitCancellation()
                } finally {
                    ended.complete(Unit)
                }
            }
            val awaited = awaiting(following)
            withTimeout(5_000) { began.await() }
            awaited.cancel(false)
            assertNotNull(withTimeoutOrNull(5_000) { ended.await() }, "$whose future, cancelled, ends the work")
        }
        endsTheWork("a running operation's") { it.awaitFuture() }
        endsTheWork("a delegation's") { Delegation(it).awaitFuture() }
    }

    @Test
    fun aCallerCancelledBeforeItWaitsEndsCancelledWhateverItsWorkCameTo() = runBlocking {
        // The work runs where it is begun, so it has ended before its caller waits for it.
        val begunHere = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val failing = { Running<String>(begunHere) { throw BusRequestError(BusRequestErrorCode.Closed, "The client closed while it was following a job") } }
        val failed = assertThrows(BusRequestError::class.java) { runBlocking { failing().await() } }
        assertEquals(BusRequestErrorCode.Closed, failed.reason, "a caller that was not cancelled is given the failure")
        val consumptions = mapOf<String, suspend () -> Any>(
            "awaited, of a work that failed" to suspend { failing().await() },
            "collected, of a work that failed" to suspend { failing().toList() },
            "awaited, of a work that gave its value" to suspend { Running(begunHere) { "done" }.await() },
        )
        for ((consumed, consume) in consumptions) {
            val ended = CompletableDeferred<Result<Any>>()
            scope.launch {
                cancel()
                ended.complete(runCatching { consume() })
            }
            assertInstanceOf(CancellationException::class.java, ended.await().exceptionOrNull(), consumed)
        }
    }

    @Test
    fun workItsClientEndedFailsAsClosed() = runBlocking {
        val client = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val running = Running<String>(client) { awaitCancellation() }
        val outcome = scope.launch { delay(50); client.cancel() }
        val refused = assertThrows(BusRequestError::class.java) { runBlocking { running.await() } }
        outcome.join()
        assertEquals(BusRequestErrorCode.Closed, refused.reason)
    }
}
