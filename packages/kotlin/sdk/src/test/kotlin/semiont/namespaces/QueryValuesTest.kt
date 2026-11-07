package semiont.namespaces

import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import semiont.Spec
import semiont.cache.Cache
import semiont.descriptorOf
import java.lang.reflect.ParameterizedType

private val queries = Spec.read("client/refresh.json").jsonObject.getValue("queries").jsonArray.map { it.jsonObject }

/**
 * The queries whose `value` waits on a ruling, and is not held here until it
 * lands: `engines`, proposed as BrowseEnginesResult's `response.engines`, the
 * engines without their limits, the cache holding them and the query joining
 * the limits as it shows them.
 */
private val WAITING_ON_A_RULING = setOf("engines")

/** What Live's cache of the query named `query` holds for a key, as Kotlin decodes it: the cache's value type. */
private fun heldBy(query: String): SerialDescriptor {
    val cache = assertInstanceOf(ParameterizedType::class.java, Live::class.java.getDeclaredField(query).genericType, "Live's $query")
    assertEquals(Cache::class.java, cache.rawType, "Live's $query is no cache")
    return serializer(cache.actualTypeArguments[1]).descriptor
}

/**
 * What each live query's cache holds, as protocol/specs/src/client/refresh.json's
 * `value` says: Live's cache of each query, by the query's name, holds the
 * component, or the member within one, that the query's row names. A query
 * the table gains fails here until Live has a cache of it by its name, and a
 * row that comes to name another value fails until its cache holds that one.
 * StoredTest holds the queries a session keeps to the same `value`.
 */
class QueryValuesTest {
    @TestFactory
    fun eachQuerysCacheHoldsWhatItsRowSaysItsValueIs(): List<DynamicTest> {
        val named = queries.map { it.getValue("name").jsonPrimitive.content }
        assertTrue(named.containsAll(WAITING_ON_A_RULING), "$WAITING_ON_A_RULING wait on a ruling, and are not all queries of the table")
        return queries.filter { it.getValue("name").jsonPrimitive.content !in WAITING_ON_A_RULING }.map { row ->
            val query = row.getValue("name").jsonPrimitive.content
            DynamicTest.dynamicTest(query) {
                assertEquals(descriptorOf(row.getValue("value").jsonObject), heldBy(query), query)
            }
        }
    }
}
