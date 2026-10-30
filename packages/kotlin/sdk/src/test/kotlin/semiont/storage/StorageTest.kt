package semiont.storage

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.Timings
import semiont.identifiers.ResourceId
import semiont.types.ResourceDescriptor
import semiont.types.wireJson

private const val KEY = "semiont.cache.kb.resource"
private val RESOURCE = ResourceId("res-1")

private fun persister(storage: SessionStorage, version: Long = 1, maxBytes: Long = Timings.MAX_STORED_BYTES_COUNT) =
    StoragePersister(storage, KEY, ResourceId.serializer(), ResourceDescriptor.serializer(), version, maxBytes)

private fun descriptor(resource: ResourceId, name: String = "A resource"): JsonObject =
    Json.parseToJsonElement("""{"@context":"https://schema.org","@id":"${resource.value}","name":"$name","representations":[]}""").jsonObject

private fun described(resource: ResourceId, name: String = "A resource"): ResourceDescriptor = wireJson.decodeFromJsonElement(ResourceDescriptor.serializer(), descriptor(resource, name))

private fun SessionStorage.document(): JsonObject = Json.parseToJsonElement(checkNotNull(get(KEY))).jsonObject

private fun JsonObject.entries(): List<JsonArray> = getValue("entries").jsonArray.map { it.jsonArray }

/** Where a client keeps what must outlive it: text under a key, and one cache's values as one document there. */
class StorageTest {
    @Test
    fun storageInMemoryHoldsTextByKey() {
        val storage = MemoryStorage()
        assertNull(storage.get("a"))
        storage.set("a", "one")
        storage.set("b", "two")
        storage.set("a", "three")
        assertEquals("three" to "two", storage.get("a") to storage.get("b"))
        storage.delete("a")
        storage.delete("never there")
        assertEquals(null to "two", storage.get("a") to storage.get("b"))
    }

    @Test
    fun anUpdateIsGivenWhatIsStoredAndStoresWhatItSays() {
        val storage = MemoryStorage()
        val given = mutableListOf<String?>()
        val appended = { stored: String? ->
            given += stored
            "${stored.orEmpty()}+"
        }
        storage.update("a", appended)
        storage.update("a", appended)
        assertEquals(listOf(null, "+"), given)
        assertEquals("++", storage.get("a"))
        // Saying nothing removes the key.
        storage.update("a") { null }
        assertNull(storage.get("a"))
    }

    @Test
    fun storageInMemoryHasNoOtherContextToHear() {
        assertNull(MemoryStorage().subscribe { _, _ -> })
    }

    @Test
    fun eachContextOfASharedStorageHearsWhatTheOthersWriteAndNeverWhatItWrites() {
        val here = SharedStorage()
        val there = here.context()
        val elsewhere = here.context()
        val heardHere = mutableListOf<Pair<String, String?>>()
        val heardThere = mutableListOf<Pair<String, String?>>()
        here.subscribe { key, value -> heardHere += key to value }
        val stopThere = checkNotNull(there.subscribe { key, value -> heardThere += key to value })

        here.set("a", "one")
        there.update("a") { stored -> "$stored, two" }
        elsewhere.delete("a")

        // Every context reads the same values.
        assertEquals(listOf<String?>(null, null, null), listOf(here.get("a"), there.get("a"), elsewhere.get("a")))
        assertEquals(listOf("a" to "one, two", "a" to null), heardHere)
        assertEquals(listOf("a" to "one", "a" to null), heardThere)

        // A subscription that has ended hears nothing.
        stopThere.close()
        elsewhere.set("b", "three")
        assertEquals(listOf("a" to "one", "a" to null), heardThere)
        assertEquals("b" to "three", heardHere.last())
        assertEquals("three", there.get("b"))
    }

    @Test
    fun aCachesValuesAreKeptAsOneDocumentAsTheWireHadThemAndComeBackAsTheyWere() {
        val storage = MemoryStorage()
        assertNull(persister(storage).load())
        val before = System.currentTimeMillis()
        persister(storage).save(mapOf(RESOURCE to described(RESOURCE)))
        val document = storage.document()
        assertEquals(setOf("version", "writtenAt", "entries"), document.keys)
        assertEquals(1L, document.getValue("version").jsonPrimitive.long)
        val (entry) = document.entries()
        assertEquals(listOf(Json.parseToJsonElement("\"res-1\""), descriptor(RESOURCE)), entry.take(2))
        assertTrue(entry[2].jsonPrimitive.long >= before)
        assertEquals(mapOf(RESOURCE to described(RESOURCE)), persister(storage).load())
    }

    @Test
    fun anEntryKeepsTheTimeItsValueWasLastWritten() {
        val storage = MemoryStorage()
        val keeping = persister(storage)
        val other = ResourceId("res-2")
        fun times() = storage.document().entries().associate { it[0].jsonPrimitive.content to it[2].jsonPrimitive.long }

        keeping.save(mapOf(RESOURCE to described(RESOURCE)))
        val first = times().getValue("res-1")
        Thread.sleep(5)
        keeping.save(mapOf(RESOURCE to described(RESOURCE), other to described(other)))
        // A value that has not changed keeps its time; one that is new is written now.
        assertEquals(first, times().getValue("res-1"))
        assertTrue(times().getValue("res-2") > first)
        // A value that changed is written now; one that is gone is gone.
        val second = times().getValue("res-2")
        Thread.sleep(5)
        keeping.save(mapOf(other to described(other, "Renamed")))
        assertEquals(setOf("res-2"), times().keys)
        assertTrue(times().getValue("res-2") > second)
        // The next life's persister knows when each was written from the document, not from having written it.
        val renamedAt = times().getValue("res-2")
        val later = persister(storage)
        assertEquals(mapOf(other to described(other, "Renamed")), later.load())
        Thread.sleep(5)
        later.save(mapOf(other to described(other, "Renamed"), RESOURCE to described(RESOURCE)))
        assertEquals(renamedAt, times().getValue("res-2"))
        assertTrue(times().getValue("res-1") > renamedAt)
    }

    @TestFactory
    fun aDocumentOfAnotherVersionOrThatDoesNotParseReadsAsNothingKept(): List<DynamicTest> = listOf(
        "not json",
        "[1, 2]",
        """{"version": 2, "writtenAt": 1, "entries": []}""",
        """{"version": "1", "writtenAt": 1, "entries": []}""",
        """{"writtenAt": 1, "entries": []}""",
        """{"version": 1, "writtenAt": 1}""",
        """{"version": 1, "writtenAt": 1, "entries": {"res-1": {}}}""",
    ).map { stored ->
        DynamicTest.dynamicTest(stored) {
            val storage = MemoryStorage()
            storage.set(KEY, stored)
            assertNull(persister(storage).load())
            // And a persister of another version reads this one's as nothing kept.
            storage.set(KEY, """{"version": 1, "writtenAt": 1, "entries": []}""")
            assertEquals(emptyMap<ResourceId, ResourceDescriptor>(), persister(storage).load())
            assertNull(persister(storage, version = 2).load())
        }
    }

    @Test
    fun anEntryThatIsNotThisCachesShapeIsOneItNeverKept() {
        val storage = MemoryStorage()
        val entries = listOf(
            """["not an id", {"@context": "https://schema.org", "@id": "res-9", "name": "n", "representations": []}, 5]""",
            """["res-3", {"name": "a description with no id"}, 5]""",
            """["res-4", {"@context": "https://schema.org", "@id": "res-4", "name": "n", "representations": []}]""",
            """["res-5", {"@context": "https://schema.org", "@id": "res-5", "name": "n", "representations": []}, "when"]""",
            """["res-6", {"@context": "https://schema.org", "@id": "res-6", "name": "n", "representations": []}, true]""",
            "\"res-7\"",
            """["res-1", ${descriptor(RESOURCE)}, 5]""",
        )
        storage.set(KEY, """{"version": 1, "writtenAt": 9, "entries": [${entries.joinToString(", ")}]}""")
        assertEquals(mapOf(RESOURCE to described(RESOURCE)), persister(storage).load())
    }

    @Test
    fun aDocumentTooLargeLosesTheEntriesThatHaveGoneLongestWithoutANewValueUntilItFits() {
        val ids = (1..4).map { ResourceId("res-$it") }
        val values = ids.associateWith { described(it) }
        fun kept(storage: SessionStorage) = storage.document().entries().map { it[0].jsonPrimitive.content }

        // How large a document of three of them is, and so the most that keeps three and not four.
        val measuring = MemoryStorage()
        persister(measuring).save(ids.take(3).associateWith { values.getValue(it) })
        val three = checkNotNull(measuring.get(KEY)).toByteArray().size.toLong() + 2

        val storage = MemoryStorage()
        val keeping = persister(storage, maxBytes = three)
        // Written at different times, the second-written first in the mapping.
        keeping.save(mapOf(ids[0] to values.getValue(ids[0])))
        Thread.sleep(5)
        keeping.save(linkedMapOf(ids[1] to values.getValue(ids[1]), ids[0] to values.getValue(ids[0])))
        Thread.sleep(5)
        keeping.save(linkedMapOf(ids[2] to values.getValue(ids[2]), ids[1] to values.getValue(ids[1]), ids[0] to values.getValue(ids[0])))
        assertEquals(ids.take(3).map { it.value }, kept(storage).sorted())
        // A fourth does not fit: the one written longest ago goes, wherever the mapping has it.
        Thread.sleep(5)
        keeping.save(linkedMapOf(ids[3] to values.getValue(ids[3]), ids[2] to values.getValue(ids[2]), ids[1] to values.getValue(ids[1]), ids[0] to values.getValue(ids[0])))
        assertEquals(listOf("res-2", "res-3", "res-4"), kept(storage))

        // A document no entry fits in keeps none, and is still a document.
        val tiny = MemoryStorage()
        persister(tiny, maxBytes = 10).save(values)
        assertEquals(emptyList<String>(), kept(tiny))
        assertEquals(emptyMap<ResourceId, ResourceDescriptor>(), persister(tiny).load())
    }
}
