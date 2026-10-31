package semiont.session

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import semiont.StateUnit

/** The next notice told, which is to come at once: one that never comes fails, rather than waits for good. */
private suspend fun <T> Channel<T>.next(): T = withTimeout(1_000) { receive() }

/** What a host shows about a session, beyond what the state-units table can state: how often a notice is told. */
class SessionSignalsTest {
    @Test
    fun raisingANoticeEqualToTheLastIsANewOccurrenceToldToEveryReader() = runBlocking {
        val signals = SessionSignals()
        val told = Channel<SessionEnded?>(Channel.UNLIMITED)
        val reading = launch(Dispatchers.Unconfined) { signals.sessionEnded.collect { told.send(it) } }
        assertNull(told.next())
        signals.notifySessionEnded(SessionEndReason.EXPIRED)
        assertEquals(SessionEnded(SessionEndReason.EXPIRED), told.next())
        // The same notice again is told again: a host shows it again.
        signals.notifySessionEnded(SessionEndReason.EXPIRED)
        assertEquals(SessionEnded(SessionEndReason.EXPIRED), told.next())
        signals.acknowledgeSessionEnded()
        assertNull(told.next())
        // Closed, every reader ends, and what is raised after is told to nobody.
        signals.close()
        withTimeout(1_000) { reading.join() }
        signals.notifySessionEnded(SessionEndReason.REFUSED)
        assertNull(signals.sessionEnded.value)
        assertNull(told.tryReceive().getOrNull())
    }

    @Test
    fun theSignalsAreAStateUnitAndClosingThemTwiceIsClosingThemOnce() {
        val signals: StateUnit = SessionSignals()
        signals.close()
        signals.close()
    }
}
