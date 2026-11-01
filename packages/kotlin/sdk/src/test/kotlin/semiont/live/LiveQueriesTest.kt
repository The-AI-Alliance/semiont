@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package semiont.live

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.cache.CacheQuery
import semiont.cache.CacheState
import semiont.errors.BusRequestError
import semiont.namespaces.EngineWithLimits
import semiont.sameJson
import semiont.storage.CachePersistence
import semiont.storage.MemoryStorage
import semiont.storage.SessionStorage
import semiont.transport.Frame
import java.util.concurrent.CountDownLatch
import kotlin.time.TimeSource

/**
 * A client's live queries: what collecting one holds, and what a read gives its
 * collectors. Each but one runs on a clock only the test moves: when one of its
 * waits ends, everything due by then has run.
 */
class LiveQueriesTest {
    @Test
    fun collectingAQueryOfAResourceHoldsItsScopeFromBeforeItAsksUntilTheCollectorLeaves() = runTest {
        val world = KbWorld(StandardTestDispatcher(testScheduler), testScheduler.timeSource, answered = false)
        val kb = world.kb
        val client = world.client
        val query = client.browse.events(RESOURCE)
        // Naming a query touches nothing.
        delay(100)
        assertEquals(emptyList<Any>() to emptyList<Frame>(), kb.scopes() to kb.emitted.toList())
        val live = world.watch(query)
        assertEquals(CacheState.Pending, live.next())
        // The scope is held before the request is made, so the events that refresh the value are coming when it arrives.
        assertEquals(1 to 1, kb.holds(RESOURCE) to kb.emitted.size)
        // A second collector, of the same query or of another of the resource, is a second hold.
        val more = listOf(world.watch(query), world.watch(client.browse.annotation(RESOURCE, ANNOTATION)), world.watch(client.gather.referencedBy(OTHER)))
        eventually { kb.holds(RESOURCE) == 3 && kb.holds(OTHER) == 1 }
        more.forEach { it.leave() }
        eventually { kb.holds(RESOURCE) == 1 && kb.scopes() == listOf(RESOURCE) }
        live.leave()
        eventually { kb.scopes().isEmpty() }

        // Every query of a resource holds its scope while it is collected.
        for (ofAResource in listOf(
            client.browse.resource(OTHER),
            client.browse.annotations(OTHER),
            client.browse.annotation(OTHER, ANNOTATION),
            client.browse.events(OTHER),
            client.gather.referencedBy(OTHER),
        )) {
            val held = world.watch(ofAResource)
            eventually { kb.holds(OTHER) == 1 && kb.scopes() == listOf(OTHER) }
            held.leave()
            eventually { kb.scopes().isEmpty() }
        }

        // A query of the knowledge base holds no scope, and neither does a read of any query.
        val ofTheKb = listOf(client.browse.resources(), client.match.resources("text"), client.browse.entityTypes(), client.browse.tagSchemas(), client.browse.engines())
            .map { world.watch(it) }
        ofTheKb.forEach { it.next() }
        assertEquals(emptyList<Any>(), kb.scopes())
        val reading = async { client.browse.resource(RESOURCE).fresh() }
        delay(100)
        assertEquals(emptyList<Any>(), kb.scopes())
        reading.cancel()
        world.close()
    }

    @Test
    fun aReadGivesWhatTheServiceAnswersNowAndEveryCollectorIsGivenItToo() = runTest {
        val world = KbWorld(StandardTestDispatcher(testScheduler), testScheduler.timeSource)
        val kb = world.kb
        kb.queue("browse:resource-requested", *listOf("first", "second").map { JsonObject(mapOf("resource" to descriptor(RESOURCE, it), "lastSequence" to JsonPrimitive(1))) }.toTypedArray())
        val live = world.watch(world.client.browse.resource(RESOURCE))
        assertEquals("first", live.ready().value.name)
        // A read asks, whatever is held.
        assertEquals("second", withTimeout(5_000) { world.client.browse.resource(RESOURCE).fresh() }.name)
        assertEquals("second", live.ready().value.name)
        // And throws the failure it meets, which no collector is shown: the value stays.
        kb.refuse("browse:resource-requested")
        assertTrue(runCatching { world.client.browse.resource(RESOURCE).fresh() }.exceptionOrNull() is BusRequestError)
        live.nothingFor()
        assertEquals(3, kb.askedFor("browse:resource-requested").size)
        world.close()
    }

    @Test
    fun invalidatingAQueryAsksAgainAndShowsItsValueMeanwhile() = runTest {
        val world = KbWorld(StandardTestDispatcher(testScheduler), testScheduler.timeSource)
        val live = world.watch(world.client.browse.entityTypes())
        assertEquals(listOf("Person"), live.ready().value)
        world.kb.queue("browse:entity-types-requested", kotlinx.serialization.json.Json.parseToJsonElement("""{"entityTypes":["Person","Place"]}"""))
        world.client.browse.entityTypes().invalidate()
        assertEquals(listOf("Person", "Place"), live.ready().value)
        assertEquals(2, world.kb.askedFor("browse:entity-types-requested").size)
        world.close()
    }

    @Test
    fun aResourcesAnnotationsAreTheListAndAListOrASearchIsOneQueryPerSetOfFilters() = runTest {
        val world = KbWorld(StandardTestDispatcher(testScheduler), testScheduler.timeSource)
        val kb = world.kb
        val client = world.client
        assertEquals(listOf(ANNOTATION), withTimeout(5_000) { client.browse.annotations(RESOURCE).fresh() }.map { it.id })

        val lists = listOf(
            client.browse.resources(),
            client.browse.resources(limit = 100),
            client.browse.resources(archived = true),
            client.browse.resources(entityType = "Person"),
            client.browse.resources(limit = 5),
        ).map { world.watch(it) }
        lists.forEach { it.ready() }
        // Stating the limit a list has anyway is the same list.
        val asked = kb.askedFor("browse:resources-requested").map { it.payload }
        assertTrue(json("""{"limit":100,"offset":0}""") in asked)
        assertTrue(json("""{"limit":100,"offset":0,"archived":true}""") in asked)
        assertTrue(json("""{"limit":100,"offset":0,"entityType":"Person"}""") in asked)
        assertTrue(json("""{"limit":5,"offset":0}""") in asked)
        assertEquals(4, asked.size)

        val before = kb.askedFor("match:resources-requested").size
        listOf(client.match.resources("a"), client.match.resources("a"), client.match.resources("b", archived = false)).map { world.watch(it) }.forEach { it.ready() }
        assertEquals(
            listOf(json("""{"search":"a","limit":100,"offset":0}"""), json("""{"search":"b","limit":100,"offset":0,"archived":false}""")),
            kb.askedFor("match:resources-requested").drop(before).map { it.payload },
        )
        world.close()
    }

    @Test
    fun theEnginesAreShownAsTheyAreAnsweredAndEachHoldersLimitsAsItReportsThem() = runTest {
        val gemma = """{"provider":"ollama","model":"gemma2:27b"}"""
        val claude = """{"provider":"anthropic","model":"claude-opus-5-5"}"""
        val world = KbWorld(StandardTestDispatcher(testScheduler), testScheduler.timeSource, answered = false)
        val kb = world.kb
        fun limitsOf(engines: List<EngineWithLimits>) = engines.map { it.limits?.contextTokens }

        val live = world.watch(world.client.browse.engines())
        assertEquals(CacheState.Pending, live.next())
        // The engines are asked for first, and each key holder after it.
        eventually { kb.emitted.size == 4 }
        assertEquals(listOf("browse:engines-requested") + LIMITS, kb.emitted.map { it.channel })
        val (engines, gather, job, match) = kb.emitted.toList()

        // A holder that answers first has nothing to be shown on yet. An engine is its provider and its model: a model of
        // the same name under another provider is another engine. What is reported first stands, and an engine not listed is shown nowhere.
        kb.answer(
            job,
            json(
                """{"limits":[
                {"engine":{"provider":"ollama","model":"claude-opus-5-5"},"limits":{"contextTokens":7,"maxOutputTokens":1}},
                {"engine":$gemma,"limits":{"contextTokens":8192,"maxOutputTokens":1}},
                {"engine":$gemma,"limits":{"contextTokens":9999,"maxOutputTokens":1}},
                {"engine":{"provider":"ollama","model":"unlisted"},"limits":{"contextTokens":1,"maxOutputTokens":1}}]}""",
            ),
        )
        live.nothingFor()

        // The engines are shown when they are answered, with what has been reported so far: they wait for no holder.
        kb.answer(engines, json("""{"engines":[{"engine":$gemma},{"engine":$claude}]}"""))
        var shown = live.ready().value
        assertEquals(listOf("gemma2:27b", "claude-opus-5-5"), shown.map { it.entry.engine.model })
        assertEquals(listOf(8192.0, null), limitsOf(shown))

        // A holder that reports later delays only its own engines' limits.
        kb.answer(gather, json("""{"limits":[{"engine":$claude,"limits":{"contextTokens":9,"maxOutputTokens":1}}]}"""))
        shown = live.ready().value
        assertEquals(listOf(8192.0, 9.0), limitsOf(shown))

        // And one that fails reports none: nothing changes, and nothing is failed.
        kb.refuse(match)
        live.nothingFor()
        assertEquals(4, kb.emitted.size)

        // Asking again asks for the engines and every holder again, and shows what there is meanwhile.
        world.client.browse.engines().invalidate()
        eventually { kb.emitted.size == 8 }
        assertEquals(listOf("browse:engines-requested") + LIMITS, kb.emitted.drop(4).map { it.channel })
        live.nothingFor()
        kb.answer(kb.emitted[4], json("""{"engines":[{"engine":$claude}]}"""))
        shown = live.ready().value
        assertEquals(listOf("claude-opus-5-5"), shown.map { it.entry.engine.model })
        assertEquals(listOf(9.0), limitsOf(shown))
        world.close()
    }

    @Test
    fun enginesThatFailAreAFailedStateWhateverTheirHoldersReportAndAReadOfThemThrows() = runTest {
        val world = KbWorld(StandardTestDispatcher(testScheduler), testScheduler.timeSource)
        world.kb.refuse("browse:engines-requested")
        val refused = runCatching { world.client.browse.engines().fresh() }.exceptionOrNull()
        assertEquals("bus.rejected", (refused as BusRequestError).code)
        val live = world.watch(world.client.browse.engines())
        var state = live.next()
        while (state !is CacheState.Failed) state = live.next()
        assertEquals("bus.rejected", assertInstanceOf(BusRequestError::class.java, state.error).code)
        world.client.close()
        // A closed client's engines are nobody's to collect.
        val closed = world.watch(world.client.browse.engines())
        closed.ends()
        assertFalse(closed.ended.isCancelled)
        world.close()
    }

    @Test
    fun aClientKeepsItsSmallQueriesAndTheNextClientShowsThemAtOnceAndAsksForThemAnew() = runBlocking {
        val storage = MemoryStorage()
        // The client's write of the annotation's detail lands late, once the test lets it.
        val late = LateWrite(storage, "semiont.cache.kb.annotation-detail")
        val persistence = CachePersistence(late, "kb")
        fun kept(name: String): JsonObject? = storage.get("semiont.cache.kb.$name")?.let { Json.parseToJsonElement(it).jsonObject }

        // On threads and in real time: the late write holds the thread that makes it while the client's other work goes on.
        val world = KbWorld(Dispatchers.Default, TimeSource.Monotonic, persistence = persistence)
        val client = world.client
        assertTrue(client.persistenceSettled)
        withTimeout(5_000) {
            client.browse.resource(RESOURCE).fresh()
            client.browse.annotations(RESOURCE).fresh()
            client.browse.annotation(RESOURCE, ANNOTATION).fresh()
            client.browse.entityTypes().fresh()
            client.browse.tagSchemas().fresh()
            // The reads take longer than a save waits: each kept query's save begins before the last read is made.
            delay(semiont.Timings.SAVE_DEBOUNCE_MS * 4)
            client.browse.events(RESOURCE).fresh()
            client.gather.referencedBy(RESOURCE).fresh()
            client.browse.resources().fresh()
            client.match.resources("text").fresh()
            client.browse.engines().fresh()
        }
        // A save that has begun is owed no more: the client is settled while its last write has yet to land.
        eventually { client.persistenceSettled }
        assertNull(kept("annotation-detail"))
        late.letGo()
        eventually { kept("annotation-detail") != null }
        // An event about an annotation nobody holds changes nothing the client keeps: nothing is owed, and nothing is written.
        val written = storage.get("semiont.cache.kb.annotation-detail")
        world.kb.deliver(event(semiont.cache.CacheRefreshTrigger.MarkDeleteOk, of = semiont.identifiers.AnnotationId("ann-nobody-holds")))
        delay(semiont.Timings.SAVE_DEBOUNCE_MS * 4)
        assertTrue(client.persistenceSettled)
        assertEquals(written, storage.get("semiont.cache.kb.annotation-detail"))
        world.close()

        // The five small queries, each a document under the client's prefix; a list, a search and a history are not kept.
        for (name in listOf("resource", "annotations", "annotation-detail", "entity-types", "tag-schemas")) {
            assertEquals(1L, checkNotNull(kept(name)) { name }.getValue("version").jsonPrimitive.long)
        }
        for (unkept in listOf("lists", "resources", "events", "referenced-by", "matched-resources", "searches", "engines", "limits")) assertNull(kept(unkept), unkept)
        // As the wire had it: by the wire's names, and without what the knowledge base never said.
        val (resource) = checkNotNull(kept("resource")).getValue("entries").jsonArray.map { it.jsonArray }
        assertTrue(sameJson(JsonArray(listOf(JsonPrimitive(RESOURCE.value), descriptor(RESOURCE))), JsonArray(resource.take(2))))
        val (listed) = checkNotNull(kept("annotations")).getValue("entries").jsonArray.map { it.jsonArray }
        assertTrue(sameJson(json("""{"annotations":[${annotation(ANNOTATION, RESOURCE)}],"total":1}"""), listed[1]))

        // The next client of the same knowledge base, over the same storage: shown at once, with no pending before it, and asked for anew, once.
        val again = KbWorld(Dispatchers.Default, TimeSource.Monotonic, persistence = persistence)
        val live = again.watch(again.client.browse.resource(RESOURCE))
        val types = again.watch(again.client.browse.entityTypes())
        assertEquals("A resource", (live.next() as CacheState.Ready).value.name)
        assertEquals(CacheState.Ready(listOf("Person")), types.next())
        // Two collectors, each asking from its own thread: once each, in no order.
        eventually { again.asked() == mapOf("browse:resource-requested" to 1, "browse:entity-types-requested" to 1) }
        // An annotation that was kept is asked for anew too, by a request that names its resource.
        assertTrue(again.watch(again.client.browse.annotation(RESOURCE, ANNOTATION)).next() is CacheState.Ready)
        eventually { again.kb.emitted.size == 3 }
        assertEquals(json("""{"resourceId":"${RESOURCE.value}","annotationId":"${ANNOTATION.value}"}"""), again.kb.emitted.last().payload)
        again.close()

        // A client of another knowledge base, over the same storage, begins with nothing of this one's.
        val other = KbWorld(Dispatchers.Default, TimeSource.Monotonic, answered = false, persistence = CachePersistence(storage, "another"))
        assertEquals(CacheState.Pending, other.watch(other.client.browse.resource(RESOURCE)).next())
        other.close()
    }

    @Test
    fun aClientThatKeepsNothingIsAlwaysSettled() = runTest {
        val world = KbWorld(StandardTestDispatcher(testScheduler), testScheduler.timeSource)
        val reading = async { world.client.browse.resource(RESOURCE).fresh() }
        assertTrue(world.client.persistenceSettled)
        withTimeout(5_000) { reading.await() }
        assertTrue(world.client.persistenceSettled)
        world.close()
    }

    @TestFactory
    fun aClientIsSettledUnlessAQueryItKeepsIsBeingFetchedOrIsOwedToStorage(): List<DynamicTest> = CacheQuery.entries.map { query ->
        DynamicTest.dynamicTest(query.wire) {
            runTest {
                val world = KbWorld(StandardTestDispatcher(testScheduler), testScheduler.timeSource, answered = false, persistence = CachePersistence(MemoryStorage(), "kb"))
                val client = world.client
                val named = mapOf(
                    CacheQuery.Resource to client.browse.resource(RESOURCE),
                    CacheQuery.Annotations to client.browse.annotations(RESOURCE),
                    CacheQuery.Annotation to client.browse.annotation(RESOURCE, ANNOTATION),
                    CacheQuery.Events to client.browse.events(RESOURCE),
                    CacheQuery.ReferencedBy to client.gather.referencedBy(RESOURCE),
                    CacheQuery.Resources to client.browse.resources(),
                    CacheQuery.MatchedResources to client.match.resources("text"),
                    CacheQuery.EntityTypes to client.browse.entityTypes(),
                    CacheQuery.TagSchemas to client.browse.tagSchemas(),
                    CacheQuery.Engines to client.browse.engines(),
                )
                assertEquals(CacheQuery.entries.toSet(), named.keys)
                val reading = async { named.getValue(query).fresh() }
                delay(100)
                // Fetching what it keeps, it is not at rest; fetching what it does not keep, it is.
                assertEquals(query !in KEPT, client.persistenceSettled)
                reading.cancel()
                world.close()
            }
        }
    }
}

/** The queries a client with a storage keeps. */
private val KEPT = setOf(CacheQuery.Resource, CacheQuery.Annotations, CacheQuery.Annotation, CacheQuery.EntityTypes, CacheQuery.TagSchemas)

/** A storage whose write of `key` waits until `letGo`. Every other read and write is the storage's own. */
private class LateWrite(private val beneath: SessionStorage, private val key: String) : SessionStorage by beneath {
    private val open = CountDownLatch(1)

    fun letGo() = open.countDown()

    override fun set(key: String, value: String) {
        if (key == this.key) open.await()
        beneath.set(key, value)
    }
}
