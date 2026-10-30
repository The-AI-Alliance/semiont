@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package semiont.cache

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import semiont.Timings
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode

private const val KEY = "k"

private val PENDING: CacheState<Int> = CacheState.Pending

private fun ready(value: Int): CacheState<Int> = CacheState.Ready(value)

/** A service a test answers for: each request waits until the test says what it is answered. */
private class Service {
    /** The key of each request, in the order they were made. */
    val asked = mutableListOf<String>()
    private val waiting = mutableListOf<CompletableDeferred<Int>>()

    suspend fun fetch(key: String): Int {
        asked += key
        val answer = CompletableDeferred<Int>()
        waiting += answer
        return answer.await()
    }

    fun answer(request: Int, value: Int) {
        waiting[request].complete(value)
    }

    fun fail(request: Int, why: String = "the service is down"): BusRequestError {
        val error = BusRequestError(BusRequestErrorCode.Timeout, why)
        waiting[request].completeExceptionally(error)
        return error
    }
}

/** A persister that holds what it was given, and counts the saves. */
private class Kept(val kept: Map<String, Int>? = null) : CachePersister<String, Int> {
    val saves = mutableListOf<Map<String, Int>>()

    override fun load(): Map<String, Int>? = kept

    override fun save(entries: Map<String, Int>) {
        saves += entries.toMap()
    }
}

/** One observer of a key: the states it was given, read as states are, the latest of what has come. */
private class Observer(states: Flow<CacheState<Int>>, scope: CoroutineScope) {
    val given = Channel<CacheState<Int>>(Channel.UNLIMITED)
    val reading: Job = scope.launch {
        states.collect { given.send(it) }
        given.close()
    }
}

/** A cache over a service the test answers for, whose fetches run in `tasks`, which the test closes. */
private class World(test: TestScope, persister: Kept? = null) {
    val service = Service()
    val tasks = CoroutineScope(SupervisorJob() + StandardTestDispatcher(test.testScheduler))
    val cache = Cache(service::fetch, tasks, persister)
    private val observing = CoroutineScope(SupervisorJob() + StandardTestDispatcher(test.testScheduler))

    fun observe(key: String = KEY) = Observer(cache.observe(key), observing)

    fun close() {
        observing.cancel()
        tasks.cancel()
    }
}

/** The state an observer is given next, which is to be there already: the latest of what has come. */
private fun TestScope.now(observer: Observer): CacheState<Int> {
    runCurrent()
    var latest: CacheState<Int>? = null
    while (true) latest = observer.given.tryReceive().getOrNull() ?: break
    return checkNotNull(latest) { "the observer was given nothing" }
}

/** The observer has been given nothing since it was last read. */
private fun TestScope.nothingMore(observer: Observer) {
    runCurrent()
    val given = observer.given.tryReceive()
    assertTrue(given.isFailure && !given.isClosed, "the observer was given ${given.getOrNull()}")
}

/** The observer's states have ended, with nothing more given. */
private fun TestScope.ended(observer: Observer) {
    runCurrent()
    assertTrue(observer.given.tryReceive().isClosed, "the observer's states have not ended")
}

/** An observer of `KEY`, which the first request has answered `value`. */
private fun TestScope.readied(world: World, value: Int): Observer {
    val observer = world.observe()
    assertEquals(PENDING, now(observer))
    world.service.answer(0, value)
    assertEquals(ready(value), now(observer))
    return observer
}

/** The cache a client's live queries answer from, held to docs/protocol/CACHE-SEMANTICS.md clause by clause. */
class CacheTest {
    @Test
    fun b1TheFirstObserverOfAKeySeesItPendingCostsOneRequestAndSeesItsAnswer() = runTest {
        val world = World(this)
        assertNull(world.cache.get(KEY))
        assertFalse(world.cache.known(KEY))
        val observer = world.observe()
        assertEquals(PENDING, now(observer))
        assertEquals(listOf(KEY), world.service.asked)
        assertTrue(world.cache.known(KEY))
        assertEquals(listOf(KEY), world.cache.keys())
        world.service.answer(0, 7)
        assertEquals(ready(7), now(observer))
        assertEquals(7, world.cache.get(KEY))
        assertEquals(listOf(KEY), world.service.asked)
        world.close()
    }

    @Test
    fun b2ALaterObserverIsGivenTheValueAndCostsNoRequest() = runTest {
        val world = World(this)
        readied(world, 7)
        assertEquals(ready(7), now(world.observe()))
        assertEquals(listOf(KEY), world.service.asked)
        world.close()
    }

    @Test
    fun b3ObserversThatArriveBeforeTheValueShareOneRequestAndSeeTheSameValue() = runTest {
        val world = World(this)
        val one = world.observe()
        val other = world.observe()
        assertEquals(PENDING to PENDING, now(one) to now(other))
        assertEquals(listOf(KEY), world.service.asked)
        // A one-shot read while it is in flight joins it too.
        val read = async { world.cache.fetch(KEY) }
        runCurrent()
        assertEquals(listOf(KEY), world.service.asked)
        world.service.answer(0, 7)
        assertEquals(Triple(ready(7), ready(7), 7), Triple(now(one), now(other), read.await()))
        world.close()
    }

    @Test
    fun b6ARefetchThatFailsAndFailsAgainLeavesTheValueItWasToReplace() = runTest {
        val world = World(this)
        val observer = readied(world, 1)
        world.cache.invalidate(KEY)
        nothingMore(observer)
        world.service.fail(1)
        runCurrent()
        world.service.fail(2)
        runCurrent()
        // The value stays, and the key is never failed: stale beats an error.
        assertEquals(listOf(KEY, KEY, KEY), world.service.asked)
        assertEquals(1, world.cache.get(KEY))
        nothingMore(observer)
        assertEquals(ready(1), now(world.observe()))
        world.close()
    }

    @Test
    fun b7InvalidatingAsksAgainAndShowsTheValueUntilTheNewOneArrives() = runTest {
        val world = World(this)
        val observer = readied(world, 1)
        world.cache.invalidate(KEY)
        nothingMore(observer)
        assertEquals(listOf(KEY, KEY), world.service.asked)
        assertEquals(1, world.cache.get(KEY))
        world.service.answer(1, 2)
        assertEquals(ready(2), now(observer))
        world.close()
    }

    @Test
    fun b8InvalidatingAKeyNobodyAskedForAsksForIt() = runTest {
        val world = World(this)
        world.cache.invalidate(KEY)
        runCurrent()
        assertEquals(listOf(KEY), world.service.asked)
        assertTrue(world.cache.known(KEY))
        world.service.answer(0, 4)
        runCurrent()
        assertEquals(4, world.cache.get(KEY))
        // And one whose only request failed twice is pending again when it is invalidated.
        val other = world.observe("other")
        assertEquals(PENDING, now(other))
        world.service.fail(1)
        runCurrent()
        val failure = world.service.fail(2)
        assertEquals(CacheState.Failed(failure), now(other))
        world.cache.invalidate("other")
        assertEquals(PENDING, now(other))
        world.service.answer(3, 9)
        assertEquals(ready(9), now(other))
        world.close()
    }

    @Test
    fun b9InvalidatingWhileAFetchIsInFlightStartsAnotherAndTheLastAnswerIsTheValue() = runTest {
        val world = World(this)
        val observer = world.observe()
        assertEquals(PENDING, now(observer))
        world.cache.invalidate(KEY)
        runCurrent()
        // Not joined: the one in flight may never be answered.
        assertEquals(listOf(KEY, KEY), world.service.asked)
        world.service.answer(1, 5)
        assertEquals(ready(5), now(observer))
        // And when it is answered after all, it is as new as what was there.
        world.service.answer(0, 3)
        assertEquals(ready(3), now(observer))
        // The newer fetch's end did not clear the way for a third: nothing is in flight, and the next observer asks nothing.
        assertEquals(ready(3), now(world.observe()))
        assertEquals(listOf(KEY, KEY), world.service.asked)
        world.close()
    }

    @Test
    fun b9AFetchThatWasLetGoOfDoesNotTakeThePlaceOfTheOneAfterIt() = runTest {
        val world = World(this)
        world.observe()
        runCurrent()
        world.cache.invalidate(KEY)
        runCurrent()
        // The older ends first, while the newer is still in flight: a read now joins the newer.
        world.service.answer(0, 3)
        runCurrent()
        val read = async { world.cache.fetch(KEY) }
        runCurrent()
        assertEquals(listOf(KEY, KEY), world.service.asked)
        world.service.answer(1, 5)
        assertEquals(5, read.await())
        world.close()
    }

    @Test
    fun b10KeysAreIndependent() = runTest {
        val world = World(this)
        val one = world.observe("a")
        val other = world.observe("b")
        assertEquals(PENDING to PENDING, now(one) to now(other))
        assertEquals(listOf("a", "b"), world.service.asked)
        world.service.answer(1, 2)
        assertEquals(ready(2), now(other))
        nothingMore(one)
        world.cache.invalidate("b")
        runCurrent()
        assertEquals(listOf("a", "b", "b"), world.service.asked)
        assertEquals(listOf("a", "b"), world.cache.keys().sorted())
        world.cache.invalidateAll()
        runCurrent()
        assertEquals(listOf("a", "b"), world.service.asked.drop(3).sorted())
        world.close()
    }

    @Test
    fun b14AFetchForAnObserverThatFailsIsMadeOnceMoreAndNoMore() = runTest {
        val world = World(this)
        val observer = world.observe()
        assertEquals(PENDING, now(observer))
        world.service.fail(0)
        nothingMore(observer)
        assertEquals(listOf(KEY, KEY), world.service.asked)
        world.service.answer(1, 7)
        assertEquals(ready(7), now(observer))
        runCurrent()
        assertEquals(listOf(KEY, KEY), world.service.asked)
        world.close()
    }

    @Test
    fun b14AOneShotReadIsNeverRetriedAndItsFailureIsItsCallersAlone() = runTest {
        val world = World(this)
        val read = async { runCatching { world.cache.fetch(KEY) } }
        runCurrent()
        val failure = world.service.fail(0)
        assertSame(failure, read.await().exceptionOrNull())
        runCurrent()
        assertEquals(listOf(KEY), world.service.asked)
        // A failure writes nothing: the key is as it was, and its first observer asks.
        assertNull(world.cache.get(KEY))
        assertEquals(PENDING, now(world.observe()))
        assertEquals(listOf(KEY, KEY), world.service.asked)
        world.close()
    }

    @Test
    fun b14TheRetryJoinsAFetchAnotherCallerStartedMeanwhile() = runTest {
        val world = World(this)
        val observer = world.observe()
        val read = async { runCatching { world.cache.fetch(KEY) } }
        runCurrent()
        assertEquals(listOf(KEY), world.service.asked)
        val failure = world.service.fail(0)
        assertSame(failure, read.await().exceptionOrNull())
        // The observer's retry is one request, and a read made while it is in flight is the same one.
        val again = async { world.cache.fetch(KEY) }
        runCurrent()
        assertEquals(listOf(KEY, KEY), world.service.asked)
        world.service.answer(1, 7)
        assertEquals(7, again.await())
        assertEquals(ready(7), now(observer))
        world.close()
    }

    @Test
    fun b15AKeyWithNoValueWhoseRetryFailsTooIsFailedForEveryObserverWhoLiveOn() = runTest {
        val world = World(this)
        val one = world.observe()
        val other = world.observe()
        assertEquals(PENDING to PENDING, now(one) to now(other))
        world.service.fail(0, "the first")
        runCurrent()
        val failure = world.service.fail(1, "the retry")
        // The retry's failure, not the first's.
        assertEquals(CacheState.Failed(failure), now(one))
        assertEquals(CacheState.Failed(failure), now(other))
        assertTrue(world.cache.known(KEY))
        assertNull(world.cache.get(KEY))
        assertEquals(listOf(KEY, KEY), world.service.asked)

        // An observer arriving starts over, for everyone: all three are pending, and then ready.
        val arriving = world.observe()
        assertEquals(PENDING, now(arriving))
        assertEquals(PENDING to PENDING, now(one) to now(other))
        assertEquals(listOf(KEY, KEY, KEY), world.service.asked)
        world.service.answer(2, 7)
        assertEquals(Triple(ready(7), ready(7), ready(7)), Triple(now(one), now(other), now(arriving)))
        world.close()
    }

    @Test
    fun b15AFailedKeyIsMadeReadyByAValueHoweverItComesWithNoPendingBetween() = runTest {
        fun failed(): Pair<World, Observer> {
            val world = World(this)
            val observer = world.observe()
            assertEquals(PENDING, now(observer))
            world.service.fail(0)
            runCurrent()
            val failure = world.service.fail(1)
            assertEquals(CacheState.Failed(failure), now(observer))
            return world to observer
        }

        // A value that is known.
        val (known, knownObserver) = failed()
        known.cache.set(KEY, 3)
        assertEquals(ready(3), now(knownObserver))
        assertEquals(listOf(KEY, KEY), known.service.asked)
        known.close()

        // A one-shot read's answer.
        val (read, readObserver) = failed()
        val reading = async { read.cache.fetch(KEY) }
        runCurrent()
        read.service.answer(2, 4)
        assertEquals(4, reading.await())
        assertEquals(ready(4), now(readObserver))
        read.close()
    }

    @Test
    fun b13aARemovedKeyIsFailedAsItWasToldAtOnceAndNothingIsAskedFor() = runTest {
        val world = World(this)
        val observer = readied(world, 1)
        val gone = BusRequestError(BusRequestErrorCode.NotFound, "it was removed")
        world.cache.remove(KEY, gone)
        assertEquals(CacheState.Failed(gone), now(observer))
        assertNull(world.cache.get(KEY))
        assertTrue(world.cache.known(KEY))
        assertEquals(listOf(KEY), world.service.asked)
        // An observer arriving asks the service, which is who knows.
        assertEquals(PENDING, now(world.observe()))
        assertEquals(listOf(KEY, KEY), world.service.asked)
        // A fetch in flight when the key is removed is let go of: a read after it does not join it.
        world.cache.remove(KEY, gone)
        val read = async { world.cache.fetch(KEY) }
        runCurrent()
        assertEquals(listOf(KEY, KEY, KEY), world.service.asked)
        read.cancel()
        world.close()
    }

    @Test
    fun aValueThatIsKnownIsWrittenAndNothingIsAskedFor() = runTest {
        val world = World(this)
        world.cache.set(KEY, 3)
        assertEquals(3, world.cache.get(KEY))
        val observer = world.observe()
        assertEquals(ready(3), now(observer))
        world.cache.set(KEY, 4)
        assertEquals(ready(4), now(observer))
        assertEquals(emptyList<String>(), world.service.asked)
        world.close()
    }

    @Test
    fun anObserverThatFallsBehindIsGivenTheLatestStateNotEachItMissed() = runTest {
        val world = World(this)
        world.cache.set(KEY, 1)
        val observer = world.observe()
        assertEquals(ready(1), now(observer))
        world.cache.set(KEY, 2)
        world.cache.set(KEY, 3)
        runCurrent()
        assertEquals(ready(3), observer.given.tryReceive().getOrNull())
        nothingMore(observer)
        world.close()
    }

    @Test
    fun b16DisposingEndsEveryObserverAndNothingIsAskedOrWrittenAfter() = runTest {
        val world = World(this)
        val observer = readied(world, 1)
        val waiting = world.observe("waiting")
        assertEquals(PENDING, now(waiting))
        world.cache.dispose()
        world.cache.dispose()
        ended(observer)
        ended(waiting)

        // An observer arriving is given nothing, and costs nothing.
        ended(world.observe())
        ended(world.observe("new"))
        val read = async { runCatching { world.cache.fetch(KEY) } }
        assertEquals("bus.closed", (read.await().exceptionOrNull() as BusRequestError).code)
        world.cache.invalidate(KEY)
        world.cache.invalidateAll()
        world.cache.set(KEY, 9)
        world.cache.remove(KEY, BusRequestError(BusRequestErrorCode.NotFound, "gone"))
        runCurrent()
        assertEquals(listOf(KEY, "waiting"), world.service.asked)
        assertEquals(Triple(null, false, emptyList<String>()), Triple(world.cache.get(KEY), world.cache.known(KEY), world.cache.keys()))

        // What was in flight is answered into nothing.
        world.service.answer(1, 5)
        runCurrent()
        assertNull(world.cache.get("waiting"))
        world.close()
    }

    @Test
    fun b16ARetryThatStraddlesTheDisposalIsNeverMade() = runTest {
        val world = World(this)
        val observer = world.observe()
        assertEquals(PENDING, now(observer))
        world.cache.dispose()
        world.service.fail(0)
        runCurrent()
        assertEquals(listOf(KEY), world.service.asked)
        world.close()
    }

    @Test
    fun aReadWhoseFetchItsClientsClosingEndedFailsAsClosedAndOneThatIsAbandonedIsOnlyAbandoned() = runTest {
        val world = World(this)
        val abandoned = async { world.cache.fetch(KEY) }
        val read = async { runCatching { world.cache.fetch(KEY) } }
        runCurrent()
        // Its caller stops waiting: the fetch goes on for the other.
        abandoned.cancel()
        runCurrent()
        assertTrue(abandoned.isCancelled)
        assertFalse(read.isCompleted)
        assertEquals(listOf(KEY), world.service.asked)
        world.close()
        assertEquals("bus.closed", (read.await().exceptionOrNull() as BusRequestError).code)
    }

    @Test
    fun b17ACacheBeginsWithWhatWasKeptAndB18AsksForItAnewTheFirstTimeItIsObserved() = runTest {
        val world = World(this, Kept(mapOf(KEY to 1, "unobserved" to 2)))
        assertEquals(1, world.cache.get(KEY))
        assertEquals(listOf(KEY, "unobserved"), world.cache.keys().sorted())
        assertEquals(emptyList<String>(), world.service.asked)

        // Shown at once, with no pending before it, and asked for again: nothing says it is still true.
        val observer = world.observe()
        assertEquals(ready(1), now(observer))
        assertEquals(listOf(KEY), world.service.asked)
        // Once: a second observer, while that is in flight and after, asks nothing.
        assertEquals(ready(1), now(world.observe()))
        world.service.answer(0, 5)
        assertEquals(ready(5), now(observer))
        assertEquals(ready(5), now(world.observe()))
        assertEquals(listOf(KEY), world.service.asked)
        // Only what is observed: the other kept key cost nothing.
        assertEquals(2, world.cache.get("unobserved"))
        world.close()
    }

    @Test
    fun b18AKeptValueWhoseRevalidationFailsTwiceStaysAndIsNotAskedForAThirdTime() = runTest {
        val world = World(this, Kept(mapOf(KEY to 1)))
        assertEquals(ready(1), now(world.observe()))
        world.service.fail(0)
        runCurrent()
        world.service.fail(1)
        runCurrent()
        assertEquals(1, world.cache.get(KEY))
        assertEquals(ready(1), now(world.observe()))
        assertEquals(listOf(KEY, KEY), world.service.asked)
        world.close()
    }

    @Test
    fun b18AKeptValueIsNoLongerOneOnceAnythingHasAskedForItOrWrittenIt() = runTest {
        for (first in listOf("a read", "an invalidation", "a value that is known", "its removal")) {
            val world = World(this, Kept(mapOf(KEY to 1)))
            var asked = 1
            when (first) {
                "a read" -> {
                    val read = async { world.cache.fetch(KEY) }
                    runCurrent()
                    world.service.answer(0, 2)
                    assertEquals(2, read.await())
                }
                "an invalidation" -> {
                    world.cache.invalidate(KEY)
                    runCurrent()
                    world.service.answer(0, 2)
                    runCurrent()
                }
                "a value that is known" -> {
                    world.cache.set(KEY, 2)
                    asked = 0
                }
                else -> {
                    world.cache.remove(KEY, BusRequestError(BusRequestErrorCode.NotFound, "gone"))
                    asked = 0
                }
            }
            assertEquals(asked, world.service.asked.size, first)
            now(world.observe())
            // The removed key is asked for by its first observer, as any failed key is: not because it was kept.
            assertEquals(if (first == "its removal") 1 else asked, world.service.asked.size, first)
            world.close()
        }
    }

    @Test
    fun b17ValuesAreSavedOnceTheyHaveStoppedChangingAndOnlyValues() = runTest {
        val persister = Kept()
        val world = World(this, persister)
        val cache = world.cache
        assertFalse(cache.persistencePending)
        val failing = world.observe("failing")
        assertEquals(PENDING, now(failing))
        // Fetching, it has not kept what it knows.
        assertTrue(cache.persistencePending)
        world.service.fail(0)
        runCurrent()
        val failure = world.service.fail(1)
        assertEquals(CacheState.Failed(failure), now(failing))
        assertFalse(cache.persistencePending)

        cache.set("a", 1)
        assertTrue(cache.persistencePending)
        advanceTimeBy(Timings.SAVE_DEBOUNCE_MS - 10)
        cache.set("b", 2)
        // The wait begins again with each change: a burst is one save.
        advanceTimeBy(Timings.SAVE_DEBOUNCE_MS - 10)
        assertEquals(emptyList<Map<String, Int>>(), persister.saves)
        assertTrue(cache.persistencePending)
        advanceTimeBy(20)
        // A failure is not a value, and is not kept.
        assertEquals(listOf(mapOf("a" to 1, "b" to 2)), persister.saves)
        assertFalse(cache.persistencePending)

        // A removal is a change too, and what is gone is no longer kept.
        cache.remove("a", BusRequestError(BusRequestErrorCode.NotFound, "gone"))
        assertTrue(cache.persistencePending)
        advanceTimeBy(100)
        assertEquals(listOf(mapOf("b" to 2)), persister.saves.drop(1))
        // And a fetched value is saved as a known one is.
        val fetched = world.observe("c")
        assertEquals(PENDING, now(fetched))
        world.service.answer(2, 3)
        assertEquals(ready(3), now(fetched))
        advanceTimeBy(100)
        assertEquals(listOf(mapOf("b" to 2, "c" to 3)), persister.saves.drop(2))
        world.close()
    }

    @Test
    fun b17DisposingMakesASaveThatWasOwedAtOnceAndNoneIsMadeAfter() = runTest {
        val persister = Kept()
        val world = World(this, persister)
        world.cache.set("a", 1)
        world.cache.dispose()
        assertEquals(listOf(mapOf("a" to 1)), persister.saves)
        world.cache.set("b", 2)
        advanceTimeBy(200)
        assertEquals(listOf(mapOf("a" to 1)), persister.saves)

        // With nothing owed, disposing saves nothing.
        val idle = Kept(mapOf("a" to 1))
        val resting = World(this, idle)
        resting.cache.dispose()
        assertEquals(emptyList<Map<String, Int>>(), idle.saves)
        world.close()
        resting.close()
    }

    @Test
    fun aCacheThatKeepsNothingOwesNothing() = runTest {
        val world = World(this)
        world.observe()
        world.cache.set("a", 1)
        runCurrent()
        assertFalse(world.cache.persistencePending)
        world.close()
    }

    @Test
    fun aFetchLetGoOfThatFailsIsNobodysFailure() = runTest {
        val world = World(this)
        world.observe()
        runCurrent()
        // Let go of by an invalidation: nobody awaits the first fetch any more, and its failure fails no one.
        world.cache.invalidate(KEY)
        runCurrent()
        world.service.fail(0)
        world.service.answer(1, 2)
        runCurrent()
        assertEquals(2, world.cache.get(KEY))
        world.close()
    }
}
