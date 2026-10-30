@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package semiont.transport

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.time.Duration.Companion.seconds

/** What a value something holds tells its readers: what every `Watched` of the SDK is read from. */
class VariableTest {
    @Test
    fun aChangeIsToldAndAValueEqualToTheOneHeldIsNone() = runTest(timeout = 10.seconds) {
        val held = Variable("a")
        val told = mutableListOf<String>()
        val reading = launch { held.reading().collect { told += it } }
        runCurrent()
        held.set("a")
        runCurrent()
        held.set("b")
        runCurrent()
        assertEquals(listOf("a", "b"), told)
        reading.cancel()
    }

    @Test
    fun anOccurrenceIsToldEachTimeEqualToTheLastOrNot() = runTest(timeout = 10.seconds) {
        val held = Variable("a")
        val told = mutableListOf<String>()
        val reading = launch { held.reading().collect { told += it } }
        runCurrent()
        held.raise("a")
        runCurrent()
        assertEquals(listOf("a", "a"), told)
        reading.cancel()
    }

    @Test
    fun theEndEndsEveryReaderAndTellsNothingAfter() = runTest(timeout = 10.seconds) {
        val held = Variable("a")
        val told = mutableListOf<String>()
        val reading = launch { held.reading().collect { told += it } }
        runCurrent()
        held.end()
        held.set("b")
        runCurrent()
        assertTrue(reading.isCompleted)
        assertEquals(listOf("a"), told, "the end is no new occurrence")
        assertEquals("a", held.value)
    }

    @Test
    fun aReaderAfterTheEndIsGivenTheValueItEndedOnAndEnds() = runTest(timeout = 10.seconds) {
        val held = Variable<String?>(null)
        held.end()
        assertEquals(listOf(null), held.reading().toList())
    }

    @Test
    fun aValueSetJustBeforeTheEndReachesAReaderThatHadNotCaughtUp() = runTest(timeout = 10.seconds) {
        val held = Variable("open")
        val told = mutableListOf<String>()
        val reading = launch { held.reading().collect { told += it } }
        runCurrent()
        // Set and ended before the reader runs again: the reader is told the value, then ends.
        held.set("closed")
        held.end()
        runCurrent()
        assertTrue(reading.isCompleted)
        assertEquals(listOf("open", "closed"), told)
    }
}
