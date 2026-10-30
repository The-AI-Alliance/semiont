package semiont.live

import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import semiont.cache.CacheState
import semiont.errors.BusRequestError
import semiont.namespaces.Collaborator
import semiont.transport.Frame

/** A client's live queries: what collecting one holds, and what a read gives its collectors. */
class LiveQueriesTest {
    @Test
    fun collectingAQueryOfAResourceHoldsItsScopeFromBeforeItAsksUntilTheCollectorLeaves() = runBlocking {
        val world = KbWorld(answered = false)
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
        val ofTheKb = listOf(client.browse.resources(), client.match.resources("text"), client.browse.entityTypes(), client.browse.tagSchemas(), client.browse.agents())
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
    fun aReadGivesWhatTheServiceAnswersNowAndEveryCollectorIsGivenItToo() = runBlocking {
        val world = KbWorld()
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
    fun invalidatingAQueryAsksAgainAndShowsItsValueMeanwhile() = runBlocking {
        val world = KbWorld()
        val live = world.watch(world.client.browse.entityTypes())
        assertEquals(listOf("Person"), live.ready().value)
        world.kb.queue("browse:entity-types-requested", kotlinx.serialization.json.Json.parseToJsonElement("""{"entityTypes":["Person","Place"]}"""))
        world.client.browse.entityTypes().invalidate()
        assertEquals(listOf("Person", "Place"), live.ready().value)
        assertEquals(2, world.kb.askedFor("browse:entity-types-requested").size)
        world.close()
    }

    @Test
    fun aResourcesAnnotationsAreTheListAndAListOrASearchIsOneQueryPerSetOfFilters() = runBlocking {
        val world = KbWorld()
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
    fun theCollaboratorsAreShownAsTheDirectoryAnswersAndEachHoldersLimitsAsItReportsThem() = runBlocking {
        val gemma = """{"@type":"Software","name":"gemma","provider":"ollama","model":"gemma2:27b"}"""
        val claude = """{"@type":"Software","name":"claude","provider":"anthropic","model":"claude-opus-5-5"}"""
        val world = KbWorld(answered = false)
        val kb = world.kb
        fun limitsOf(collaborators: List<Collaborator>) = collaborators.map { it.limits?.contextTokens }

        val live = world.watch(world.client.browse.agents())
        assertEquals(CacheState.Pending, live.next())
        // The directory is asked for first, and each key holder after it.
        eventually { kb.emitted.size == 4 }
        assertEquals(listOf("browse:agents-requested") + LIMITS, kb.emitted.map { it.channel })
        val (directory, gather, job, match) = kb.emitted.toList()

        // A holder that answers before the directory has nothing to be shown on yet.
        kb.answer(job, json("""{"limits":[{"provider":"ollama","model":"gemma2:27b","limits":{"contextTokens":8192,"maxOutputTokens":1}}]}"""))
        live.nothingFor()

        // The directory is shown when it answers, with what has been reported so far: it waits for no holder.
        kb.answer(directory, json("""{"agents":[{"agent":$gemma},{"agent":$claude}]}"""))
        var shown = live.ready().value
        assertEquals(listOf("gemma", "claude"), shown.map { (it.entry.agent as semiont.types.AgentSoftware).name })
        assertEquals(listOf(8192.0, null), limitsOf(shown))

        // A holder that reports later delays only its own models' limits.
        kb.answer(gather, json("""{"limits":[{"provider":"anthropic","model":"claude-opus-5-5","limits":{"contextTokens":9,"maxOutputTokens":1}}]}"""))
        shown = live.ready().value
        assertEquals(listOf(8192.0, 9.0), limitsOf(shown))

        // And one that fails reports none: nothing changes, and nothing is failed.
        kb.refuse(match)
        live.nothingFor()
        assertEquals(4, kb.emitted.size)

        // Asking again asks the directory and every holder again, and shows what there is meanwhile.
        world.client.browse.agents().invalidate()
        eventually { kb.emitted.size == 8 }
        assertEquals(listOf("browse:agents-requested") + LIMITS, kb.emitted.drop(4).map { it.channel })
        live.nothingFor()
        kb.answer(kb.emitted[4], json("""{"agents":[{"agent":$claude}]}"""))
        shown = live.ready().value
        assertEquals(listOf("claude"), shown.map { (it.entry.agent as semiont.types.AgentSoftware).name })
        assertEquals(listOf(9.0), limitsOf(shown))
        world.close()
    }

    @Test
    fun aDirectoryThatFailsIsAFailedStateWhateverItsHoldersReportAndAReadOfItThrows() = runBlocking {
        val world = KbWorld()
        world.kb.refuse("browse:agents-requested")
        val refused = runCatching { world.client.browse.agents().fresh() }.exceptionOrNull()
        assertEquals("bus.rejected", (refused as BusRequestError).code)
        val live = world.watch(world.client.browse.agents())
        var state = live.next()
        while (state !is CacheState.Failed) state = live.next()
        assertEquals("bus.rejected", state.error.code)
        world.client.close()
        // A closed client's collaborators are nobody's to collect.
        val closed = world.watch(world.client.browse.agents())
        closed.ends()
        assertFalse(closed.ended.isCancelled)
        world.close()
    }
}
