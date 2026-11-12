package semiont.transport

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import semiont.Timings
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/** What every reader of a stream, a bus or a failure is given things through: listeners that come and go while things are delivered. */
class BroadcastTest {
    @Test
    fun aListenerThatLeavesWhileSomethingIsDeliveredFailsNoDelivery() {
        val broadcast = Broadcast<Int>()
        val delivering = AtomicBoolean(true)
        val coming = thread(isDaemon = true) {
            while (delivering.get()) broadcast.listen().close()
        }
        try {
            repeat(DELIVERIES) { value ->
                val told = broadcast.deliver(value)
                assertTrue(told in 0..1, "told $told listeners, of one at most")
            }
        } finally {
            delivering.set(false)
            coming.join(TimeUnit.SECONDS.toMillis(10))
        }
    }

    @Test
    fun aListenerThatLeavesAsTheBroadcastClosesFailsNoClose() {
        val broadcasts = List(CLOSES) { Broadcast<Int>() }
        val listening = broadcasts.map { it.listen() }
        val arrived = AtomicInteger()
        // Both threads spin until both have come to the round, so they leave it within the same moment.
        fun meet(round: Int) {
            arrived.incrementAndGet()
            while (arrived.get() < 2 * (round + 1)) Thread.onSpinWait()
        }
        val leaving = thread(isDaemon = true) {
            listening.forEachIndexed { round, events ->
                meet(round)
                events.close()
            }
        }
        broadcasts.forEachIndexed { round, broadcast ->
            meet(round)
            broadcast.close()
        }
        leaving.join(TimeUnit.SECONDS.toMillis(10))
    }

    @Test
    fun theFirstListenerIsGivenTheLatestDeliveredBeforeAnyoneListenedInOrder() {
        val broadcast = Broadcast<Int>(keptForFirst = Timings.ERRORS_KEPT_FOR_FIRST_READER_COUNT)
        val beyond = 5
        val delivered = List(Timings.ERRORS_KEPT_FOR_FIRST_READER_COUNT.toInt() + beyond) { it }
        delivered.forEach { broadcast.deliver(it) }
        val first = broadcast.listen()
        broadcast.close()
        assertEquals(delivered.drop(beyond), runBlocking { first.toList() })
    }

    private companion object {
        const val DELIVERIES = 1_000_000
        const val CLOSES = 100_000
    }
}
