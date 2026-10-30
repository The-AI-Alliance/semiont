package semiont

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
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode

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
    fun workItsClientEndedFailsAsClosed() = runBlocking {
        val client = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val running = Running<String>(client) { awaitCancellation() }
        val outcome = scope.launch { delay(50); client.cancel() }
        val refused = assertThrows(BusRequestError::class.java) { runBlocking { running.await() } }
        outcome.join()
        assertEquals(BusRequestErrorCode.Closed, refused.reason)
    }
}
