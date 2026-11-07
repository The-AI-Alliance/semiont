package semiont.storage

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
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
import semiont.cache.PERSISTED_QUERIES
import semiont.registry.KeptQuery
import semiont.registry.lastEventIdKey
import semiont.sameJson
import semiont.types.wireJson
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private val table = Spec.read("session/cache-cases.json").jsonObject
private val stored = Spec.read("session/stored.json").jsonObject

/** The knowledge base, and the key of the person, the runner's persistence keeps its queries and its places for. */
private const val KB = "kb-a"
private const val PERSON = "the key of jo"

private fun prefixOf(member: String): String = stored.getValue(member).jsonObject.getValue("prefix").jsonPrimitive.content

/** Where stored.json says the document of the query named `query` is kept. */
private fun documentKey(query: String): String = "${prefixOf("cacheKeyPrefix")}$KB.$PERSON.$query"

/** What Kotlin keeps the query named `query` as: the one of the queries the refresh table marks persisted. */
private fun keptAs(query: String): KeptQuery<*, *> = PERSISTED_QUERIES.single { it.query.wire == query }

/** What a case keeps under its key: `stored`'s JSON text, or `storedText` as it is. */
private fun textOf(case: JsonObject): String = if ("stored" in case) case.getValue("stored").toString() else case.getValue("storedText").jsonPrimitive.content

/** Pairs of a key and a value, as a map. */
private fun pairs(listed: JsonElement): Map<JsonElement, JsonElement> = listed.jsonArray.associate { it.jsonArray[0] to it.jsonArray[1] }

private fun assertSameEntries(expected: Map<JsonElement, JsonElement>, actual: Map<JsonElement, JsonElement>) {
    assertEquals(expected.keys, actual.keys)
    for ((key, value) in expected) assertTrue(sameJson(value, actual.getValue(key)), "$key: $value is not ${actual.getValue(key)}")
}

/** That `document` is the document a case says is `written`: its entries compared as a map, and each entry's stamp a whole number of at least 0. */
private fun assertWrittenAsTheTableSays(expected: JsonObject, document: JsonObject) {
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

/** What `kept`'s persister keeps of the document in `storage`, each key and value as the wire has it. Nothing kept is none. */
private fun <K : Any, V : Any> loaded(kept: KeptQuery<K, V>, storage: SessionStorage): Map<JsonElement, JsonElement> =
    kept.persister(CachePersistence(storage, KB, PERSON)).load().orEmpty().entries.associate { (key, value) ->
        wireJson.encodeToJsonElement(kept.key, key) to wireJson.encodeToJsonElement(kept.value, value)
    }

/** What a case's cache is answered for each key it holds: `held`, read as `kept`'s keys and values. */
private fun <K : Any, V : Any> answersOf(kept: KeptQuery<K, V>, held: JsonElement): Map<K, V> =
    held.jsonArray.associate { wireJson.decodeFromJsonElement(kept.key, it.jsonArray[0]) to wireJson.decodeFromJsonElement(kept.value, it.jsonArray[1]) }

/** The document `kept`'s cache writes when it has fetched `held` and is closed. */
private fun <K : Any, V : Any> written(kept: KeptQuery<K, V>, held: JsonElement): JsonObject {
    val storage = MemoryStorage()
    val answers = answersOf(kept, held)
    // The save is the one closing makes.
    val cache = Cache<K, V>({ key -> answers.getValue(key) }, kept.persister(CachePersistence(storage, KB, PERSON)), saveDebounceMs = 60_000)
    runBlocking { answers.keys.forEach { cache.fetch(it) } }
    cache.close()
    return Json.parseToJsonElement(checkNotNull(storage.get(documentKey(kept.query.wire)))).jsonObject
}

/** A storage that refuses its first write of `refused`, keeping nothing of it, and takes every other write as `beneath` does. */
private class RefusingTheFirstWrite(private val beneath: SessionStorage, private val refused: String) : SessionStorage by beneath {
    private val asked = AtomicBoolean(false)

    /** Counted down once the write has been refused. */
    val refusal = CountDownLatch(1)

    private fun refuses(key: String): Boolean {
        if (key != refused || !asked.compareAndSet(false, true)) return false
        refusal.countDown()
        return true
    }

    override fun set(key: String, value: String) {
        if (refuses(key)) throw IOException("the storage refuses the write of $key")
        beneath.set(key, value)
    }

    override fun update(key: String, change: (String?) -> String?) {
        if (refuses(key)) throw IOException("the storage refuses the write of $key")
        beneath.update(key, change)
    }
}

/**
 * Whether `kept`'s cache, having fetched `held` over a storage that refuses
 * the first write of its document, still owes its save once that write is
 * refused; and the document its closing writes then, over the storage that
 * takes it, or none.
 */
private fun <K : Any, V : Any> writtenAfterARefusal(kept: KeptQuery<K, V>, held: JsonElement): Pair<Boolean, JsonObject?> {
    val beneath = MemoryStorage()
    val storage = RefusingTheFirstWrite(beneath, documentKey(kept.query.wire))
    val answers = answersOf(kept, held)
    // The first save is the one the answers owe, once they have stopped changing.
    val cache = Cache<K, V>({ key -> answers.getValue(key) }, kept.persister(CachePersistence(storage, KB, PERSON)), saveDebounceMs = 50)
    runBlocking { answers.keys.forEach { cache.fetch(it) } }
    assertTrue(storage.refusal.await(5, TimeUnit.SECONDS), "the cache never wrote its document")
    val owed = runBlocking {
        withTimeoutOrNull(1_000) {
            while (!cache.persistencePending) delay(5)
        } != null
    }
    cache.close()
    return owed to beneath.get(documentKey(kept.query.wire))?.let { Json.parseToJsonElement(it).jsonObject }
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
            assertWrittenAsTheTableSays(case.getValue("written").jsonObject, document)
        }
    }

    @TestFactory
    fun aWriteTheStorageRefusesLeavesTheSaveOwedAndClosingWritesWhatTheTableSays(): List<DynamicTest> =
        table.getValue("refusedWrites").jsonArray.map { it.jsonObject }.map { case ->
            DynamicTest.dynamicTest(case.getValue("name").jsonPrimitive.content) {
                val (owed, document) = writtenAfterARefusal(keptAs(case.getValue("query").jsonPrimitive.content), case.getValue("held"))
                assertTrue(owed, "the cache owes no save once the storage refused its write")
                assertWrittenAsTheTableSays(case.getValue("written").jsonObject, checkNotNull(document) { "closing wrote no document" })
            }
        }

    @TestFactory
    fun aLoadOfWhereTheStreamWasKeepsWhatTheTableSays(): List<DynamicTest> = table.getValue("places").jsonArray.map { it.jsonObject }.map { case ->
        DynamicTest.dynamicTest(case.getValue("name").jsonPrimitive.content) {
            val storage = MemoryStorage()
            storage.set("${prefixOf("lastEventIdKeyPrefix")}$KB.$PERSON", textOf(case))
            val kept = CoupledBookmarks(storage, lastEventIdKey(KB, PERSON)).load()
            assertEquals(case.getValue("kept").jsonObject.mapValues { it.value.jsonPrimitive.content }, kept.mapKeys { it.key.value })
        }
    }
}
