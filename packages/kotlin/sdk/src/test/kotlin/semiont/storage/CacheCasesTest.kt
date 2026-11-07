package semiont.storage

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import semiont.Spec
import semiont.cache.Cache
import semiont.registry.KEPT_QUERIES
import semiont.registry.KeptQuery
import semiont.registry.lastEventIdKey
import semiont.sameJson
import semiont.types.wireJson

private val table = Spec.read("session/cache-cases.json").jsonObject
private val stored = Spec.read("session/stored.json").jsonObject

/** The key prefix the runner's persistence keeps its queries under, and the knowledge base whose places it keeps. */
private const val KEY_PREFIX = "kb-a"

private fun prefixOf(member: String): String = stored.getValue(member).jsonObject.getValue("prefix").jsonPrimitive.content

/** Where stored.json says the document of the query named `query` is kept. */
private fun documentKey(query: String): String = "${prefixOf("cacheKeyPrefix")}$KEY_PREFIX.$query"

/** What Kotlin keeps the query named `query` as. */
private fun keptAs(query: String): KeptQuery<*, *> = KEPT_QUERIES.single { it.query.wire == query }

/** What a case keeps under its key: `stored`'s JSON text, or `storedText` as it is. */
private fun textOf(case: JsonObject): String = if ("stored" in case) case.getValue("stored").toString() else case.getValue("storedText").jsonPrimitive.content

/** Pairs of a key and a value, as a map. */
private fun pairs(listed: JsonElement): Map<JsonElement, JsonElement> = listed.jsonArray.associate { it.jsonArray[0] to it.jsonArray[1] }

private fun assertSameEntries(expected: Map<JsonElement, JsonElement>, actual: Map<JsonElement, JsonElement>) {
    assertEquals(expected.keys, actual.keys)
    for ((key, value) in expected) assertTrue(sameJson(value, actual.getValue(key)), "$key: $value is not ${actual.getValue(key)}")
}

/** What `kept`'s persister keeps of the document in `storage`, each key and value as the wire has it. Nothing kept is none. */
private fun <K : Any, V : Any> loaded(kept: KeptQuery<K, V>, storage: SessionStorage): Map<JsonElement, JsonElement> =
    kept.persister(CachePersistence(storage, KEY_PREFIX)).load().orEmpty().entries.associate { (key, value) ->
        wireJson.encodeToJsonElement(kept.key, key) to wireJson.encodeToJsonElement(kept.value, value)
    }

/** The document `kept`'s cache writes when it has fetched `held` and is closed. */
private fun <K : Any, V : Any> written(kept: KeptQuery<K, V>, held: JsonElement): JsonObject {
    val storage = MemoryStorage()
    val answers = held.jsonArray.associate { wireJson.decodeFromJsonElement(kept.key, it.jsonArray[0]) to wireJson.decodeFromJsonElement(kept.value, it.jsonArray[1]) }
    // The save is the one closing makes.
    val cache = Cache<K, V>({ key -> answers.getValue(key) }, kept.persister(CachePersistence(storage, KEY_PREFIX)), saveDebounceMs = 60_000)
    runBlocking { answers.keys.forEach { cache.fetch(it) } }
    cache.close()
    return Json.parseToJsonElement(checkNotNull(storage.get(documentKey(kept.query.wire)))).jsonObject
}

/**
 * What a client keeps of its queries and of its stream, and what it keeps of
 * what another client wrote, case by case (protocol/specs/src/session/cache-cases.json):
 * each case through the persister Kotlin keeps the case's query with, under
 * the key session/stored.json gives, over a storage in memory.
 */
class CacheCasesTest {
    @TestFactory
    fun aLoadKeepsWhatTheTableSays(): List<DynamicTest> = table.getValue("cases").jsonArray.map { it.jsonObject }.map { case ->
        DynamicTest.dynamicTest(case.getValue("name").jsonPrimitive.content) {
            val query = case.getValue("query").jsonPrimitive.content
            val storage = MemoryStorage()
            storage.set(documentKey(query), textOf(case))
            assertSameEntries(pairs(case.getValue("kept")), loaded(keptAs(query), storage))
        }
    }

    @TestFactory
    fun aSaveWritesWhatTheTableSays(): List<DynamicTest> = table.getValue("writes").jsonArray.map { it.jsonObject }.map { case ->
        DynamicTest.dynamicTest(case.getValue("name").jsonPrimitive.content) {
            val document = written(keptAs(case.getValue("query").jsonPrimitive.content), case.getValue("held"))
            val expected = case.getValue("written").jsonObject
            assertEquals(expected.keys, document.keys)
            assertTrue(sameJson(expected.getValue("version"), document.getValue("version")))
            val entries = document.getValue("entries").jsonArray.map { it.jsonArray }
            for (entry in entries) {
                assertEquals(3, entry.size, "$entry")
                val stamp = entry[2].jsonPrimitive
                val at = stamp.content.toBigDecimalOrNull()?.stripTrailingZeros()
                assertTrue(!stamp.isString && at != null && at.scale() <= 0 && at.signum() >= 0, "$stamp is no whole number of at least 0")
            }
            assertSameEntries(pairs(expected.getValue("entries")), pairs(JsonArray(entries)))
        }
    }

    @TestFactory
    fun aLoadOfWhereTheStreamWasKeepsWhatTheTableSays(): List<DynamicTest> = table.getValue("places").jsonArray.map { it.jsonObject }.map { case ->
        DynamicTest.dynamicTest(case.getValue("name").jsonPrimitive.content) {
            val storage = MemoryStorage()
            storage.set("${prefixOf("lastEventIdKeyPrefix")}$KEY_PREFIX", textOf(case))
            val kept = CoupledBookmarks(storage, lastEventIdKey(KEY_PREFIX)).load()
            assertEquals(case.getValue("kept").jsonObject.mapValues { it.value.jsonPrimitive.content }, kept.mapKeys { it.key.value })
        }
    }
}
