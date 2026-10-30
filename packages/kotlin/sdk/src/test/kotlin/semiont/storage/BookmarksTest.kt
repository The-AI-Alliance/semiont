package semiont.storage

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import semiont.http.HttpTransport
import semiont.http.Timing
import semiont.identifiers.ResourceId
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

private const val KEY = "semiont.lastEventId.kb-a"
private const val CACHE = "semiont.cache.kb-a.resource"
private val RESOURCE = ResourceId("res-1")
private val OTHER = ResourceId("res-2")
private val QUICK = Timing(reconnectMs = 10, lazyRemoveMs = 10, lingerMs = 10)

/** A gateway of one stream at a time: it keeps what each subscribe asked, holds the latest stream open, and writes there what a test gives it. */
private class Gateway : AutoCloseable {
    private val handling = Executors.newCachedThreadPool()
    private val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
    val subscriptions = CopyOnWriteArrayList<JsonObject>()

    @Volatile
    private var stream = CompletableFuture<OutputStream>()

    init {
        server.createContext("/bus/subscribe") { exchange ->
            subscriptions += Json.parseToJsonElement(String(exchange.requestBody.readAllBytes())).jsonObject
            exchange.responseHeaders.add("Content-Type", "text/event-stream")
            exchange.sendResponseHeaders(200, 0)
            val out = exchange.responseBody
            out.write(": open\n\n".toByteArray())
            out.flush()
            stream.complete(out)
            stream = CompletableFuture<OutputStream>().also { it.complete(out) }
        }
        server.executor = handling
        server.start()
    }

    val origin: String get() = "http://127.0.0.1:${server.address.port}"

    fun send(id: String, frame: String) {
        val out = stream.get()
        synchronized(out) {
            out.write("id: $id\nevent: bus-event\ndata: $frame\n\n".toByteArray())
            out.flush()
        }
    }

    /** Where a subscription of `scopes` scopes asks each to begin, once the gateway has been sent one. */
    suspend fun placesAskedFrom(scopes: Int): Map<String, String?> = withTimeout(5_000) {
        var found: Map<String, String?>? = null
        while (found == null) {
            found = subscriptions.reversed().firstNotNullOfOrNull { subscription ->
                (subscription["scoped"] as? JsonArray)?.takeIf { it.size == scopes }?.associate { entry ->
                    val stated = entry.jsonObject
                    stated.getValue("scope").jsonPrimitive.content to stated["lastEventId"]?.jsonPrimitive?.contentOrNull
                }
            }
            if (found == null) kotlinx.coroutines.delay(5)
        }
        found
    }

    override fun close() {
        server.stop(0)
        handling.shutdownNow()
    }
}

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
        Gateway().use { gateway ->
            HttpTransport(gateway.origin, MutableStateFlow("t"), emptyList(), QUICK, null, places).use { transport ->
                val heard = transport.frames("mark:added")
                transport.subscribeToResource(RESOURCE).use {
                    transport.subscribeToResource(OTHER).use {
                        // The scope it kept a place in resumes from it; the other begins at the present.
                        assertEquals(mapOf("res-1" to "p-41", "res-2" to null), gateway.placesAskedFrom(2))
                        // A recorded event's id is its scope's place, once it has been delivered. A passing frame's is no place.
                        gateway.send("p-42", """{"channel":"mark:added","payload":{"n":1},"scope":"res-1"}""")
                        gateway.send("e-9", """{"channel":"mark:added","payload":{"n":2},"scope":"res-2"}""")
                        val read = withTimeout(5_000) { heard.take(2) }
                        assertEquals(listOf(JsonPrimitive(1), JsonPrimitive(2)), read.map { it.payload.getValue("n") })
                        assertEquals("""{"res-1": "p-41"}""", storage.get(KEY))
                        places.storage.set(CACHE, "{}")
                        assertEquals(mapOf(RESOURCE to "p-42"), places.load())
                    }
                }
            }
        }
        // With no bookmarks, a stream begins every scope at the present and keeps nothing.
        Gateway().use { gateway ->
            HttpTransport(gateway.origin, MutableStateFlow("t"), emptyList(), QUICK).use { transport ->
                transport.subscribeToResource(RESOURCE).use {
                    assertEquals(mapOf("res-1" to null), gateway.placesAskedFrom(1))
                }
            }
        }
    }
}

/** The first `count` frames read. */
private suspend fun <T : Any> semiont.transport.Events<T>.take(count: Int): List<T> {
    val read = mutableListOf<T>()
    collect {
        read += it
        if (read.size == count) close()
    }
    return read
}
