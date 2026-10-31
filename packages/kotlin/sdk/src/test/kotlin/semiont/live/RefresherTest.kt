package semiont.live

import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.cache.CACHE_REFRESH
import semiont.cache.CacheQuery
import semiont.cache.CacheRefreshReach
import semiont.cache.CacheRefreshTrigger
import semiont.cache.CacheRefreshWhen
import semiont.cache.CacheState
import semiont.cache.Cached
import semiont.channels.BRIDGED_CHANNELS
import semiont.channels.RESOURCE_SCOPED_CHANNELS
import semiont.errors.BusRequestError
import semiont.identifiers.AnnotationId
import semiont.transport.ConnectionState
import semiont.transport.Frame
import semiont.types.Annotation
import semiont.types.wireJson

/** How long the asks an event causes are given to be made. */
private const val SETTLE = 300L

/** The queries `everything` holds two of: one of each resource, or of an annotation of each. */
private val OF_A_RESOURCE = setOf(CacheQuery.Resource, CacheQuery.Annotations, CacheQuery.Events, CacheQuery.ReferencedBy, CacheQuery.Annotation)

/** Every live query: of both resources and an annotation of each, and of the knowledge base. */
private fun everything(world: KbWorld): List<Cached<*>> {
    val browse = world.client.browse
    return listOf(RESOURCE, OTHER).flatMap { listOf(browse.resource(it), browse.annotations(it), browse.events(it), world.client.gather.referencedBy(it)) } + listOf(
        browse.annotation(RESOURCE, ANNOTATION),
        browse.annotation(OTHER, ELSEWHERE),
        browse.resources(),
        world.client.match.resources("a search"),
        browse.entityTypes(),
        browse.tagSchemas(),
        browse.engines(),
    )
}

/** What asking again for `queries` asks and reads, of everything `everything` holds, when the event is about `RESOURCE`. */
private fun expected(queries: List<CacheQuery>, reach: CacheRefreshReach): Map<String, Int> {
    val asked = mutableMapOf<String, Int>()
    for (query in queries) {
        for (operation in ASKS.getValue(query)) asked.merge(operation, if (query in OF_A_RESOURCE && reach == CacheRefreshReach.Held) 2 else 1, Int::plus)
    }
    return asked
}

/** What was asked since `before`. */
private fun since(world: KbWorld, before: Map<String, Int>): Map<String, Int> =
    world.asked().mapValues { (operation, count) -> count - (before[operation] ?: 0) }.filterValues { it > 0 }

/** The stream drops and opens again. */
private suspend fun reopen(kb: Kb) {
    kb.setState(ConnectionState.Reconnecting)
    delay(100)
    kb.setState(ConnectionState.Open)
}

/** A watcher of each query, each of which has its value. */
private suspend fun watched(world: KbWorld, queries: List<Cached<*>>): List<Watcher<*>> = queries.map { query ->
    world.watch(query).also { it.ready() }
}

/** What keeps a client's queries true: each row of specs/src/client/refresh.json, and the rules every row is applied under. */
class RefresherTest {
    @TestFactory
    fun eachRowOfTheRefreshTableDoesWhatItStatesToWhatIsHeld(): List<DynamicTest> =
        CACHE_REFRESH.flatMap { (trigger, rows) -> rows.map { trigger to it } }.map { (trigger, row) ->
            DynamicTest.dynamicTest("${trigger.wire}${row.whenIs?.let { " $it" } ?: ""}") {
                runBlocking {
                    val world = KbWorld()
                    watched(world, everything(world))
                    val one = world.watch(world.client.browse.annotation(RESOURCE, ANNOTATION)).also { it.ready() }
                    val listed = world.watch(world.client.browse.annotations(RESOURCE)).also { it.ready() }
                    delay(SETTLE)

                    val before = world.asked()
                    if (trigger == CacheRefreshTrigger.Reopened) reopen(world.kb) else world.kb.deliver(event(trigger, row.whenIs))
                    delay(SETTLE)
                    assertEquals(expected(row.refetches, row.reach), since(world, before))

                    val written = wireJson.decodeFromJsonElement(Annotation.serializer(), annotation(ANNOTATION, RESOURCE, "2026-10-06T01:00:00.000Z"))
                    // The event carried the annotation: it is the value, and nobody was asked.
                    if (CacheQuery.Annotation in row.writes) assertEquals(CacheState.Ready(written), one.next())
                    if (CacheQuery.Annotations in row.writes) assertEquals(CacheState.Ready(listOf(written)), listed.next())
                    if (CacheQuery.Annotation in row.removes) {
                        assertEquals("bus.not-found", assertInstanceOf(CacheState.Failed::class.java, one.next()).error.code)
                    }
                    assertTrue(row.writes.all { it in setOf(CacheQuery.Annotation, CacheQuery.Annotations) })
                    assertTrue(row.removes.all { it == CacheQuery.Annotation })
                    world.close()
                }
            }
        }

    @Test
    fun everyTriggerButTheReopeningIsAChannelAClientHears() {
        val events = CacheRefreshTrigger.entries.filter { it != CacheRefreshTrigger.Reopened }
        assertTrue(events.isNotEmpty())
        for (trigger in events) assertTrue(trigger.wire in BRIDGED_CHANNELS || trigger.wire in RESOURCE_SCOPED_CHANNELS, trigger.wire)
        assertEquals(CacheQuery.entries.toSet(), ASKS.keys)
    }

    @Test
    fun b19TheRefetchesEventsAskOfOneKeyInsideAWindowAreOneRefetch() = runBlocking {
        val window = 400L
        val world = KbWorld(windowMs = window)
        val kb = world.kb
        fun asked() = kb.askedFor("browse:resource-requested").size
        fun listsAndSearches() = kb.askedFor("browse:resources-requested").size to kb.askedFor("match:resources-requested").size

        watched(world, listOf(world.client.browse.resource(RESOURCE), world.client.browse.resource(OTHER), world.client.browse.resources(), world.client.match.resources("text")))
        assertEquals(2, asked())
        assertEquals(1 to 1, listsAndSearches())

        // The first runs at once, and opens the key's window.
        kb.deliver(event(CacheRefreshTrigger.YieldUpdated))
        eventually { asked() == 3 }
        // Any more inside it are owed, and are one.
        repeat(5) { kb.deliver(event(CacheRefreshTrigger.YieldUpdated)) }
        delay(100)
        assertEquals(3, asked())
        // The lists are one key and the searches another, whichever resource an event names: each was asked for again by
        // the first, and owes one more whatever came after.
        assertEquals(2 to 2, listsAndSearches())
        // A window is one key's: another key's first runs at once.
        kb.deliver(event(CacheRefreshTrigger.YieldUpdated, resource = OTHER))
        eventually { asked() == 4 }
        assertEquals(2 to 2, listsAndSearches())

        // The window closes: what it owed runs, once, and that opens the next.
        eventually { asked() == 5 }
        eventually { listsAndSearches() == 3 to 3 }
        assertEquals(JsonObject(mapOf("resourceId" to JsonPrimitive(RESOURCE.value))), kb.askedFor("browse:resource-requested").last().payload)
        kb.deliver(event(CacheRefreshTrigger.YieldUpdated))
        delay(100)
        assertEquals(5, asked())
        eventually { asked() == 6 }

        // A window that owed nothing closes, and the next event runs at once.
        delay(window + 100)
        assertEquals(6, asked())
        kb.deliver(event(CacheRefreshTrigger.YieldUpdated))
        eventually { asked() == 7 }

        // What a window owes when the client closes is dropped.
        kb.deliver(event(CacheRefreshTrigger.YieldUpdated))
        delay(50)
        world.close()
        delay(window + 100)
        assertEquals(7, asked())
    }

    @Test
    fun b20AnEventAsksAgainOnlyForWhatTheCacheHolds() = runBlocking {
        val world = KbWorld(windowMs = 0)
        // Nothing is held: no event of any kind asks for anything.
        for (trigger in CacheRefreshTrigger.entries) if (trigger != CacheRefreshTrigger.Reopened) world.kb.deliver(event(trigger))
        reopen(world.kb)
        delay(SETTLE)
        assertEquals(emptyList<Frame>(), world.kb.emitted.toList())

        watched(world, listOf(world.client.browse.events(RESOURCE)))
        val before = world.kb.emitted.size
        // Of what `mark:added` names, the events are held and the annotations are not; and no other resource's are.
        world.kb.deliver(event(CacheRefreshTrigger.MarkAdded))
        world.kb.deliver(event(CacheRefreshTrigger.MarkAdded, resource = OTHER))
        delay(SETTLE)
        assertEquals(
            listOf("browse:events-requested" to JsonObject(mapOf("resourceId" to JsonPrimitive(RESOURCE.value)))),
            world.kb.emitted.drop(before).map { it.channel to it.payload },
        )
        world.close()
    }

    @Test
    fun b20AKeyThatIsFailedOrBeingFetchedIsHeld() = runBlocking {
        LaggingThread().use { lagging ->
            val world = KbWorld(windowMs = 0)
            val kb = world.kb
            fun requests() = kb.askedFor("browse:events-requested")
            // Each request waits until the test refuses it: until then the key is being fetched, whenever its watcher catches up.
            kb.hold("browse:events-requested")
            val failing = Watcher(world.client.browse.events(RESOURCE), lagging.scope)
            assertEquals(CacheState.Pending, failing.next())
            eventually { requests().size == 1 }
            kb.refuse(requests()[0])
            // Asked once more when that failed, and failed when that was refused too.
            eventually { requests().size == 2 }
            kb.refuse(requests()[1])
            assertInstanceOf(CacheState.Failed::class.java, failing.next())
            // Its watcher lags while the event asks again.
            lagging.whileBusy {
                kb.deliver(event(CacheRefreshTrigger.MarkAdded))
                eventually { requests().size == 3 }
            }
            assertEquals(CacheState.Pending, failing.next())
            kb.refuse(requests()[2])
            // And once more when that failed.
            eventually { requests().size == 4 }
            world.close()
        }

        // One whose first request nobody has answered.
        val waiting = KbWorld(windowMs = 0, answered = false)
        waiting.watch(waiting.client.browse.events(RESOURCE))
        eventually { waiting.kb.askedFor("browse:events-requested").size == 1 }
        waiting.kb.deliver(event(CacheRefreshTrigger.MarkAdded))
        eventually { waiting.kb.askedFor("browse:events-requested").size == 2 }
        waiting.close()
    }

    @Test
    fun anEventThatCannotBeReadAsksAgainForEverythingHeld() = runBlocking {
        val world = KbWorld()
        watched(world, everything(world))
        delay(SETTLE)
        // Something changed and nothing says what.
        var before = world.asked()
        world.kb.deliver(Frame("mark:added", json("""{"not":"a recorded event"}"""), null, RESOURCE))
        delay(SETTLE)
        assertEquals(expected(CacheQuery.entries, CacheRefreshReach.Held), since(world, before))
        // And a frame on a channel that is no trigger asks for nothing.
        before = world.asked()
        world.kb.deliver(Frame("beckon:focus", json("""{"resourceId":"${RESOURCE.value}","annotationId":"${ANNOTATION.value}"}""")))
        delay(SETTLE)
        assertEquals(emptyMap<String, Int>(), since(world, before))
        world.close()
    }

    @Test
    fun b13OnlyAStreamThatLeftOpenAndReturnedHasReopened() = runBlocking {
        val world = KbWorld(windowMs = 0)
        val kb = world.kb
        kb.setState(ConnectionState.Initial)
        fun asked() = kb.askedFor("browse:entity-types-requested").size
        // Its first opening is no reopening: nothing was missed. What was watched before it waits for it, and asks once.
        val types = world.watch(world.client.browse.entityTypes())
        assertEquals(CacheState.Pending, types.next())
        kb.setState(ConnectionState.Connecting)
        delay(100)
        kb.setState(ConnectionState.Open)
        types.ready()
        delay(SETTLE)
        assertEquals(1, asked())

        // Down, and a failed attempt to return, and then back: one reopening.
        for (state in listOf(ConnectionState.Reconnecting, ConnectionState.Connecting, ConnectionState.Reconnecting, ConnectionState.Connecting)) {
            kb.setState(state)
            delay(50)
        }
        assertEquals(1, asked())
        kb.setState(ConnectionState.Open)
        eventually { asked() == 2 }

        // And each drop after it is another.
        reopen(kb)
        eventually { asked() == 3 }
        world.close()
    }

    @Test
    fun b13bAnEventThatCarriesAnAnnotationWritesItWhereItWasOrAtTheEndAndAsksNothing() = runBlocking {
        val world = KbWorld(windowMs = 0)
        val kb = world.kb
        val listed = world.watch(world.client.browse.annotations(RESOURCE)).also { it.ready() }
        delay(SETTLE)
        var before = kb.emitted.size
        val fresh = AnnotationId("ann-new")
        // One the list does not hold is added at its end, and is then an annotation the client holds.
        val added = JsonObject(recorded("mark:body-updated", RESOURCE, json("""{"annotationId":"ann-new"}""")) + ("annotation" to annotation(fresh, RESOURCE, "2026-10-06T02:00:00.000Z")))
        kb.deliver(Frame("mark:body-updated", added, null, RESOURCE))
        assertEquals(listOf(ANNOTATION to null, fresh to "2026-10-06T02:00:00.000Z"), listed.ready().value.map { it.id to it.modified })
        // One it holds is replaced where it was.
        kb.deliver(event(CacheRefreshTrigger.MarkBodyUpdated, CacheRefreshWhen.Enriched))
        assertEquals(listOf(ANNOTATION to "2026-10-06T01:00:00.000Z", fresh to "2026-10-06T02:00:00.000Z"), listed.ready().value.map { it.id to it.modified })
        delay(SETTLE)
        assertEquals(before, kb.emitted.size)

        // The annotation it carried is the value of that annotation's own query, though nobody had asked for it.
        val one = world.watch(world.client.browse.annotation(RESOURCE, ANNOTATION))
        assertEquals("2026-10-06T01:00:00.000Z", one.ready().value.modified)
        delay(SETTLE)
        assertEquals(before, kb.emitted.size)

        // And the annotation the first event carried is one of its resource's, though no query of it was ever named: what
        // is asked again of the resource's annotations is asked of it too, by a request that names the resource.
        kb.deliver(event(CacheRefreshTrigger.BusResumeGap))
        delay(SETTLE)
        assertTrue(json("""{"resourceId":"${RESOURCE.value}","annotationId":"ann-new"}""") in kb.askedFor("browse:annotation-requested").map { it.payload })
        before = kb.emitted.size

        // An event about a resource whose list is not held writes no list.
        val elsewhere = JsonObject(recorded("mark:body-updated", OTHER, json("""{"annotationId":"${ELSEWHERE.value}"}""")) + ("annotation" to annotation(ELSEWHERE, OTHER)))
        kb.deliver(Frame("mark:body-updated", elsewhere, null, OTHER))
        delay(SETTLE)
        assertEquals(before, kb.emitted.size)
        // What it shows is what the knowledge base answers, and none of what the event carried.
        assertEquals(listOf(ANNOTATION), world.watch(world.client.browse.annotations(OTHER)).ready().value.map { it.id })
        world.close()
    }

    @Test
    fun b13aAnAnnotationThatIsGoneEndsAsNotFoundAndItsNextWatcherAsksNamingItsResource() = runBlocking {
        LaggingThread().use { lagging ->
            val world = KbWorld(windowMs = 0)
            val kb = world.kb
            val one = Watcher(world.client.browse.annotation(RESOURCE, ANNOTATION), lagging.scope).also { it.ready() }
            val asked = kb.askedFor("browse:annotation-requested").size
            // One nobody holds is nobody's to end.
            kb.deliver(event(CacheRefreshTrigger.MarkDeleteOk, of = ELSEWHERE))
            kb.deliver(event(CacheRefreshTrigger.MarkDeleteOk))
            val failed = assertInstanceOf(CacheState.Failed::class.java, one.next())
            assertEquals("bus.not-found" to "Annotation ${ANNOTATION.value} was removed", failed.error.code to failed.error.message)
            delay(SETTLE)
            assertEquals(asked, kb.askedFor("browse:annotation-requested").size)

            // Which resource it was of is kept, so the request an arriving watcher makes can name it. The first watcher lags
            // meanwhile, and the request waits until the test answers it: the key is being fetched when that watcher catches up.
            kb.hold("browse:annotation-requested")
            lagging.whileBusy {
                world.watch(world.client.browse.annotation(RESOURCE, ANNOTATION))
                eventually { kb.askedFor("browse:annotation-requested").size > asked }
            }
            assertEquals(CacheState.Pending, one.next())
            val request = kb.askedFor("browse:annotation-requested").last()
            assertEquals(json("""{"resourceId":"${RESOURCE.value}","annotationId":"${ANNOTATION.value}"}"""), request.payload)
            kb.answer(request)
            assertInstanceOf(CacheState.Ready::class.java, one.next())
            world.close()
        }
    }

    @Test
    fun aClosedClientHearsNoEventGivesAWatcherNothingAndRefusesAReadAsClosed() = runBlocking {
        val world = KbWorld(windowMs = 0)
        val kb = world.kb
        assertEquals("A resource", withTimeout(5_000) { world.client.browse.resource(RESOURCE).fresh() }.name)
        kb.deliver(event(CacheRefreshTrigger.YieldUpdated))
        delay(SETTLE)
        assertEquals(2, kb.askedFor("browse:resource-requested").size)

        world.close()
        kb.deliver(event(CacheRefreshTrigger.YieldUpdated))
        delay(SETTLE)
        assertEquals(2, kb.askedFor("browse:resource-requested").size)
        val watcher = Watcher(world.client.browse.resource(RESOURCE), this)
        watcher.ends()
        val refused = runCatching { world.client.browse.resource(RESOURCE).fresh() }.exceptionOrNull()
        assertEquals("bus.closed", (refused as BusRequestError).code)
    }

    @Test
    fun anEventThatNamesAnAnnotationAsksForThatOneAndOneThatNamesNoneForEachHeldOfItsResource() = runBlocking {
        val world = KbWorld(windowMs = 0)
        val kb = world.kb
        val third = AnnotationId("ann-3")
        fun annotationsAskedFor(since: Int) = kb.askedFor("browse:annotation-requested").drop(since).map { (it.payload.getValue("annotationId") as JsonPrimitive).content }.sorted()

        // Two annotations of one resource, and one of another.
        for ((resource, annotationId) in listOf(RESOURCE to ANNOTATION, RESOURCE to third, OTHER to ELSEWHERE)) {
            world.watch(world.client.browse.annotation(resource, annotationId)).ready()
        }
        delay(SETTLE)
        var since = kb.askedFor("browse:annotation-requested").size
        // Its body was updated, and the event does not carry it: that annotation is asked for, and no other.
        kb.deliver(event(CacheRefreshTrigger.MarkBodyUpdated, CacheRefreshWhen.Unenriched))
        delay(SETTLE)
        assertEquals(listOf(ANNOTATION.value), annotationsAskedFor(since))

        // The stream missed what was recorded of the resource: each annotation held of it is asked for, and no other resource's.
        since = kb.askedFor("browse:annotation-requested").size
        kb.deliver(event(CacheRefreshTrigger.BusResumeGap))
        delay(SETTLE)
        assertEquals(listOf(ANNOTATION.value, third.value), annotationsAskedFor(since))
        world.close()
    }

    @Test
    fun closingAClientEndsEveryQuerysWatcherAndFailsEveryReadStillWaitingAsClosed() = runBlocking {
        // The knowledge base has answered nothing when the client closes: every watcher is pending, and every read waiting.
        val world = KbWorld(answered = false)
        val watching = everything(world).map { world.watch(it) }
        for (watcher in watching) assertEquals(CacheState.Pending, watcher.next())
        val reads = everything(world).map { query -> async { runCatching { query.fresh() } } }
        delay(SETTLE)
        assertTrue(world.kb.scopes().isNotEmpty())
        world.client.close()
        for (watcher in watching) watcher.ends()
        for (read in reads) assertEquals("bus.closed", (read.await().exceptionOrNull() as BusRequestError).code)
        // Each watcher's hold on its resource's scope is let go when the watcher leaves, whatever became of the client.
        eventually { world.kb.scopes().isEmpty() }

        // Closed, it gives a watcher of any query nothing, refuses a read of any as closed, and asks the knowledge base nothing.
        val asked = world.kb.emitted.size
        for (query in everything(world)) {
            Watcher(query, this).ends()
            assertEquals("bus.closed", (runCatching { query.fresh() }.exceptionOrNull() as BusRequestError).code)
        }
        delay(SETTLE)
        assertEquals(asked, world.kb.emitted.size)
        world.close()
    }
}
