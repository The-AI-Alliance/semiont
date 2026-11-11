@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package semiont.storage

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import semiont.ClientTiming
import semiont.SemiontClient
import semiont.Timings
import semiont.cache.CACHE_REFRESH_CHANNELS
import semiont.channels.RESOURCE_SCOPED_CHANNELS
import semiont.frame
import semiont.http.HttpTransport
import semiont.http.StreamGateway
import semiont.http.Timing
import semiont.http.firstOf
import semiont.identifiers.ResourceId
import semiont.live.KbContent
import semiont.live.KbWorld
import semiont.live.recorded
import semiont.registry.cacheKey
import semiont.registry.lastEventIdKey
import semiont.testing.SharedStorage

private const val PERSON = "the key of jo"
private val KEY = lastEventIdKey("kb-a", PERSON)
private val CACHE = cacheKey("kb-a", PERSON, "resource")
private val ANNOTATIONS = cacheKey("kb-a", PERSON, "annotations")
private val RESOURCE = ResourceId("res-1")
private val OTHER = ResourceId("res-2")
private val QUICK = Timing(reconnectMs = 10, lazyRemoveMs = 10, lingerMs = 10)

/** A stream's place in each scope, kept with what the caches keep: never ahead of them. */
class BookmarksTest {
    @Test
    fun aPlaceIsWrittenWithTheNextWriteOfACacheAndNotBefore() {
        val storage = MemoryStorage()
        val places = CoupledBookmarks(storage, KEY)
        val caches = places.storage
        assertEquals(emptyMap<ResourceId, String>(), places.load())
        places.save(RESOURCE, "p-res-1-7")
        places.save(RESOURCE, "p-res-1-8")
        places.save(OTHER, "p-res-2-3")
        assertNull(storage.get(KEY))
        // Reading what a cache kept, and forgetting it, write no place.
        assertNull(caches.get(CACHE))
        caches.delete(CACHE)
        assertNull(storage.get(KEY))
        caches.set(CACHE, "{}")
        assertEquals("{}" to "{}", storage.get(CACHE) to caches.get(CACHE))
        assertEquals(mapOf(RESOURCE to "p-res-1-8", OTHER to "p-res-2-3"), places.load())
        // A later place of one scope leaves the other's as it was.
        places.save(OTHER, "p-res-2-4")
        caches.set(CACHE, "{}")
        assertEquals(mapOf(RESOURCE to "p-res-1-8", OTHER to "p-res-2-4"), places.load())
        // With nothing reached since, a cache's write writes no places: what another client kept meanwhile stays.
        storage.set(KEY, """{"res-9": "p-res-9-1"}""")
        caches.set(CACHE, "{}")
        assertEquals(mapOf(ResourceId("res-9") to "p-res-9-1"), places.load())
        caches.delete(CACHE)
        assertNull(storage.get(CACHE))
    }

    @Test
    fun aCachesUpdateCarriesThePlacesAsItsWriteDoesAndWhatIsHeardIsWhatTheStorageBeneathHears() {
        val beneath = SharedStorage()
        val places = CoupledBookmarks(beneath, KEY)
        places.save(RESOURCE, "p-res-1-7")
        places.storage.update(CACHE) { kept -> "${kept.orEmpty()}{}" }
        assertEquals("{}" to mapOf(RESOURCE to "p-res-1-7"), beneath.get(CACHE) to places.load())

        val heard = mutableListOf<Pair<String, String?>>()
        checkNotNull(places.storage.subscribe { key, value -> heard += key to value }).use {
            beneath.context().set(CACHE, "[]")
        }
        assertEquals(listOf(CACHE to "[]"), heard)
    }

    @Test
    fun anIdThatIsNoPersistedEventsIdIsNoPlaceToKeep() {
        val storage = MemoryStorage()
        val places = CoupledBookmarks(storage, KEY)
        places.save(RESOURCE, "e-res-1-7")
        places.save(OTHER, "p-7")
        places.storage.set(CACHE, "{}")
        assertNull(storage.get(KEY))
        assertEquals(emptyMap<ResourceId, String>(), places.load())
    }

    @Test
    fun aPlaceWaitsForTheCachesOfTheClientItIsCoupledToToBeAtRest() = runTest {
        val storage = MemoryStorage()
        val places = CoupledBookmarks(storage, KEY)
        // A client that keeps its caches beside the places, over a knowledge base that answers only when the test does.
        val world = KbWorld(StandardTestDispatcher(testScheduler), testScheduler.timeSource, answered = false, persistence = CachePersistence(places.storage, "kb-a", PERSON))
        places.coupleTo(world.client)
        // A query the client keeps is being fetched: the client is not at rest.
        val reading = async { world.client.browse.resource(RESOURCE).fresh() }
        delay(100)
        assertFalse(world.client.persistenceSettled)
        places.save(RESOURCE, "p-res-1-7")
        places.storage.set(ANNOTATIONS, "{}")
        // Late, which is safe: the cache that was written may not be the one still taking the event in.
        assertNull(storage.get(KEY))
        // Answered, the resource is saved once its value has stopped changing, and that save, made at rest, carries the place.
        world.kb.answer(world.kb.askedFor("browse:resource-requested").single())
        reading.await()
        delay(Timings.SAVE_DEBOUNCE_MS * 2)
        assertNotNull(storage.get(CACHE))
        assertEquals(mapOf(RESOURCE to "p-res-1-7"), places.load())
        world.close()
    }

    @Test
    fun aPlaceIsNotedOnlyOnceTheRefresherHasTakenItsEvent() = runBlocking {
        val storage = MemoryStorage()
        // What an earlier client kept of res-1's annotations: the client holds them, so an event of res-1 asks for them again.
        storage.set(ANNOTATIONS, """{"version":1,"entries":[["res-1",{"annotations":[],"total":0},1700000000000]]}""")
        val places = CoupledBookmarks(storage, KEY)
        // The client's work, its refresher's among it, runs only when the test runs this scheduler.
        val held = TestCoroutineScheduler()
        val content = KbContent(answered = false)
        StreamGateway().use { gateway ->
            HttpTransport(gateway.origin, MutableStateFlow("t"), emptyList(), QUICK, null, places).use { transport ->
                val client = SemiontClient(transport, content, transport, ClientTiming(), CachePersistence(places.storage, "kb-a", PERSON), StandardTestDispatcher(held), held.timeSource)
                places.coupleTo(client)
                val heard = transport.frames("mark:added")
                transport.subscribeToResource(RESOURCE).use {
                    assertEquals(mapOf("res-1" to null), gateway.placesAskedFrom(1))
                    val event = JsonObject(mapOf("channel" to JsonPrimitive("mark:added"), "payload" to recorded("mark:added", RESOURCE), "scope" to JsonPrimitive("res-1")))
                    gateway.send("p-res-1-9", event.toString())
                    // Delivered to the client, and queued for its refresher, which has not taken it.
                    withTimeout(5_000) { heard.firstOf(1) }
                    assertEquals(emptyList<ResourceId>(), content.reads)
                    // A cache written meanwhile writes no place of an event whose effects are not under way.
                    places.storage.set(CACHE, "{}")
                    assertNull(storage.get(KEY), "the place of an event the refresher had not taken was written")
                    // Taken: its refetch of the annotations is in flight, and holds the place back.
                    held.runCurrent()
                    assertEquals(listOf(RESOURCE), content.reads)
                    assertFalse(client.persistenceSettled)
                    places.storage.set(CACHE, "{}")
                    assertNull(storage.get(KEY), "the place of an event whose refetch is in flight was written")

                    // Answered, and seen through a read: the save its value owes, fired once, writes the place.
                    val refetched = async(start = CoroutineStart.UNDISPATCHED) { client.browse.annotations(RESOURCE).fresh() }
                    content.answer()
                    held.runCurrent()
                    assertEquals(1, refetched.await().size)
                    held.advanceTimeBy(Timings.SAVE_DEBOUNCE_MS)
                    held.runCurrent()
                    assertTrue(checkNotNull(storage.get(ANNOTATIONS)).contains("ann-1"), "the refetched annotations were not saved")
                    assertEquals(mapOf(RESOURCE to "p-res-1-9"), places.load())
                }
                client.close()
            }
        }
    }

    @Test
    fun aPlaceOfAFrameOnAChannelWithNoRowOfTheRefreshTableIsNotedOnceTheRefresherHasReadIt() = runBlocking {
        val channel = checkNotNull(RESOURCE_SCOPED_CHANNELS.firstOrNull { it !in CACHE_REFRESH_CHANNELS }) { "every channel a resource's scope carries has a row of the refresh table" }
        val storage = MemoryStorage()
        val places = CoupledBookmarks(storage, KEY)
        // The client's work, its refresher's among it, runs only when the test runs this scheduler.
        val held = TestCoroutineScheduler()
        StreamGateway().use { gateway ->
            HttpTransport(gateway.origin, MutableStateFlow("t"), emptyList(), QUICK, null, places).use { transport ->
                val client = SemiontClient(transport, KbContent(), transport, ClientTiming(), CachePersistence(places.storage, "kb-a", PERSON), StandardTestDispatcher(held), held.timeSource)
                places.coupleTo(client)
                val heard = transport.frames(channel)
                transport.subscribeToResource(RESOURCE).use {
                    assertEquals(mapOf("res-1" to null), gateway.placesAskedFrom(1))
                    val event = JsonObject(mapOf("channel" to JsonPrimitive(channel), "payload" to recorded(channel, RESOURCE), "scope" to JsonPrimitive("res-1")))
                    gateway.send("p-res-1-9", event.toString())
                    // Delivered to the client, and queued for its refresher, which has not read it.
                    withTimeout(5_000) { heard.firstOf(1) }
                    places.storage.set(CACHE, "{}")
                    assertNull(storage.get(KEY), "the place of a frame the refresher had not read was written")
                    // Read, with no row to apply: its place rides the next write of a kept cache.
                    held.runCurrent()
                    places.storage.set(CACHE, "{}")
                    assertEquals(mapOf(RESOURCE to "p-res-1-9"), places.load())
                }
                client.close()
            }
        }
    }

    @Test
    fun whatIsKeptUnderTheKeyAndIsNotPlacesIsNothingKept() {
        val storage = MemoryStorage()
        for (kept in listOf("not json", "[1, 2]", """{"res-1": 7}""", """{"not an id": "p-x-1"}""", """{"res-1": "e-res-1-1"}""", """{"res-1": "p-1"}""")) {
            storage.set(KEY, kept)
            assertEquals(emptyMap<ResourceId, String>(), CoupledBookmarks(storage, KEY).load(), kept)
        }
        // A pair that is not a scope and its place is not read, and the rest are.
        storage.set(KEY, """{"res-1": "e-res-1-1", "not an id": "p-x-1", "res-2": "p-res-2-3"}""")
        assertEquals(mapOf(OTHER to "p-res-2-3"), CoupledBookmarks(storage, KEY).load())
        // And is written over by the first places that are.
        storage.set(KEY, "not json")
        val places = CoupledBookmarks(storage, KEY)
        places.save(RESOURCE, "p-res-1-1")
        places.storage.set(CACHE, "{}")
        assertEquals(mapOf(RESOURCE to "p-res-1-1"), places.load())
    }

    @Test
    fun aPlaceIsWrittenAfterTheCachesOwnWriteSoOneThatFailsLeavesNoPlaceAheadOfIt() {
        /** A storage that holds what it has, and takes no cache's write. */
        val held = mutableMapOf<String, String>()
        val full = object : SessionStorage {
            override fun get(key: String): String? = held[key]

            override fun set(key: String, value: String) {
                if (key == CACHE) throw java.io.IOException("the storage is full")
                held[key] = value
            }

            override fun delete(key: String) {
                held.remove(key)
            }

            override fun update(key: String, change: (String?) -> String?) {
                val after = change(held[key])
                if (after == null) delete(key) else set(key, after)
            }

            override fun subscribe(onChange: (key: String, value: String?) -> Unit): AutoCloseable? = null
        }
        val places = CoupledBookmarks(full, KEY)
        places.save(RESOURCE, "p-res-1-7")
        assertThrows(java.io.IOException::class.java) { places.storage.set(CACHE, "{}") }
        // The cache kept nothing of what the place names, and no place says it did.
        assertNull(full.get(KEY))
        places.storage.set(ANNOTATIONS, "{}")
        assertEquals(mapOf(RESOURCE to "p-res-1-7"), places.load())
    }

    @Test
    fun aStreamBeginsEachScopeWhereItsBookmarksSayAndItsClientNotesEachRecordedEventItsRefresherTook() = runBlocking {
        val storage = MemoryStorage()
        storage.set(KEY, """{"res-1": "p-res-1-41"}""")
        val places = CoupledBookmarks(storage, KEY)
        StreamGateway().use { gateway ->
            HttpTransport(gateway.origin, MutableStateFlow("t"), emptyList(), QUICK, null, places).use { transport ->
                val client = SemiontClient(transport, KbContent(), transport, ClientTiming(), CachePersistence(places.storage, "kb-a", PERSON))
                places.coupleTo(client)
                val heard = transport.frames("mark:added")
                transport.subscribeToResource(RESOURCE).use {
                    transport.subscribeToResource(OTHER).use {
                        // The scope it kept a place in resumes from it; the other begins at the present.
                        assertEquals(mapOf("res-1" to "p-res-1-41", "res-2" to null), gateway.placesAskedFrom(2))
                        // A recorded event's id is its scope's place, once the client's refresher has taken the event, even one it cannot read.
                        // A passing frame's is no place.
                        gateway.send("p-res-1-42", """{"channel":"mark:added","payload":{"n":1},"scope":"res-1"}""")
                        gateway.send("e-9", """{"channel":"mark:added","payload":{"n":2},"scope":"res-2"}""")
                        val read = withTimeout(5_000) { heard.firstOf(2) }
                        assertEquals(listOf(JsonPrimitive(1), JsonPrimitive(2)), read.map { it.frame().payload.getValue("n") })
                        assertEquals("""{"res-1": "p-res-1-41"}""", storage.get(KEY))
                        // Written with a cache's write made once the client is settled: the second unreadable event's refetch is owed until its window closes.
                        withTimeout(5_000) {
                            while (places.load() != mapOf(RESOURCE to "p-res-1-42")) {
                                places.storage.set(CACHE, "{}")
                                delay(10)
                            }
                        }
                    }
                }
                client.close()
            }
        }
        // With no bookmarks, a stream begins every scope at the present and keeps nothing.
        StreamGateway().use { gateway ->
            HttpTransport(gateway.origin, MutableStateFlow("t"), emptyList(), QUICK).use { transport ->
                transport.subscribeToResource(RESOURCE).use {
                    assertEquals(mapOf("res-1" to null), gateway.placesAskedFrom(1))
                }
            }
        }
    }
}
