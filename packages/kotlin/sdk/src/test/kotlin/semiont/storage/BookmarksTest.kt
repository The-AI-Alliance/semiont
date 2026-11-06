package semiont.storage

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import semiont.frame
import semiont.http.HttpTransport
import semiont.http.StreamGateway
import semiont.http.Timing
import semiont.http.firstOf
import semiont.identifiers.ResourceId
import semiont.testing.SharedStorage

private const val KEY = "semiont.lastEventId.kb-a"
private const val CACHE = "semiont.cache.kb-a.resource"
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
        places.save(RESOURCE, "p-7")
        places.save(RESOURCE, "p-8")
        places.save(OTHER, "p-3")
        assertNull(storage.get(KEY))
        // Reading what a cache kept, and forgetting it, write no place.
        assertNull(caches.get(CACHE))
        caches.delete(CACHE)
        assertNull(storage.get(KEY))
        caches.set(CACHE, "{}")
        assertEquals("{}" to "{}", storage.get(CACHE) to caches.get(CACHE))
        assertEquals(mapOf(RESOURCE to "p-8", OTHER to "p-3"), places.load())
        // A later place of one scope leaves the other's as it was.
        places.save(OTHER, "p-4")
        caches.set(CACHE, "{}")
        assertEquals(mapOf(RESOURCE to "p-8", OTHER to "p-4"), places.load())
        // With nothing reached since, a cache's write writes no places: what another client kept meanwhile stays.
        storage.set(KEY, """{"res-9": "p-1"}""")
        caches.set(CACHE, "{}")
        assertEquals(mapOf(ResourceId("res-9") to "p-1"), places.load())
        caches.delete(CACHE)
        assertNull(storage.get(CACHE))
    }

    @Test
    fun aCachesUpdateCarriesThePlacesAsItsWriteDoesAndWhatIsHeardIsWhatTheStorageBeneathHears() {
        val beneath = SharedStorage()
        val places = CoupledBookmarks(beneath, KEY)
        places.save(RESOURCE, "p-7")
        places.storage.update(CACHE) { kept -> "${kept.orEmpty()}{}" }
        assertEquals("{}" to mapOf(RESOURCE to "p-7"), beneath.get(CACHE) to places.load())

        val heard = mutableListOf<Pair<String, String?>>()
        checkNotNull(places.storage.subscribe { key, value -> heard += key to value }).use {
            beneath.context().set(CACHE, "[]")
        }
        assertEquals(listOf(CACHE to "[]"), heard)
    }

    @Test
    fun aPlaceWaitsForTheCachesToBeAtRest() {
        val storage = MemoryStorage()
        val places = CoupledBookmarks(storage, KEY)
        var atRest = false
        places.flushGate = { atRest }
        places.save(RESOURCE, "p-7")
        places.storage.set(CACHE, "{}")
        // Late, which is safe: the cache that was written may not be the one still taking the event in.
        assertNull(storage.get(KEY))
        atRest = true
        places.storage.set("semiont.cache.kb-a.annotations", "{}")
        assertEquals(mapOf(RESOURCE to "p-7"), places.load())
    }

    @Test
    fun whatIsKeptUnderTheKeyAndIsNotPlacesIsNothingKept() {
        val storage = MemoryStorage()
        for (kept in listOf("not json", "[1, 2]", """{"res-1": 7}""", """{"not an id": "p-1"}""")) {
            storage.set(KEY, kept)
            assertEquals(emptyMap<ResourceId, String>(), CoupledBookmarks(storage, KEY).load(), kept)
        }
        // And is written over by the first places that are.
        val places = CoupledBookmarks(storage, KEY)
        places.save(RESOURCE, "p-1")
        places.storage.set(CACHE, "{}")
        assertEquals(mapOf(RESOURCE to "p-1"), places.load())
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
        places.save(RESOURCE, "p-7")
        assertThrows(java.io.IOException::class.java) { places.storage.set(CACHE, "{}") }
        // The cache kept nothing of what the place names, and no place says it did.
        assertNull(full.get(KEY))
        places.storage.set("semiont.cache.kb-a.annotations", "{}")
        assertEquals(mapOf(RESOURCE to "p-7"), places.load())
    }

    @Test
    fun aStreamBeginsEachScopeWhereItsBookmarksSayAndTellsThemEachRecordedEventItDelivered() = runBlocking {
        val storage = MemoryStorage()
        storage.set(KEY, """{"res-1": "p-41"}""")
        val places = CoupledBookmarks(storage, KEY)
        StreamGateway().use { gateway ->
            HttpTransport(gateway.origin, MutableStateFlow("t"), emptyList(), QUICK, null, places).use { transport ->
                val heard = transport.frames("mark:added")
                transport.subscribeToResource(RESOURCE).use {
                    transport.subscribeToResource(OTHER).use {
                        // The scope it kept a place in resumes from it; the other begins at the present.
                        assertEquals(mapOf("res-1" to "p-41", "res-2" to null), gateway.placesAskedFrom(2))
                        // A recorded event's id is its scope's place, once it has been delivered. A passing frame's is no place.
                        gateway.send("p-42", """{"channel":"mark:added","payload":{"n":1},"scope":"res-1"}""")
                        gateway.send("e-9", """{"channel":"mark:added","payload":{"n":2},"scope":"res-2"}""")
                        val read = withTimeout(5_000) { heard.firstOf(2) }
                        assertEquals(listOf(JsonPrimitive(1), JsonPrimitive(2)), read.map { it.frame().payload.getValue("n") })
                        assertEquals("""{"res-1": "p-41"}""", storage.get(KEY))
                        places.storage.set(CACHE, "{}")
                        assertEquals(mapOf(RESOURCE to "p-42"), places.load())
                    }
                }
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
