package semiont.bus

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.Spec
import semiont.channels.Channel
import semiont.channels.Channels
import semiont.channels.ScopedChannel
import semiont.identifiers.ResourceId
import semiont.sameJson

/**
 * The bus log's form, and what a line shows of a payload: the table every bus
 * log runs (specs/src/bus/log-cases.json), which lists the names a credential
 * is withheld under.
 */
class BusLogTest {
    private val table = Spec.read("bus/log-cases.json").jsonObject
    private val names = table.getValue("names").jsonArray.map { it.jsonPrimitive.content }
    private val cases = table.getValue("cases").jsonArray.map { it.jsonObject }

    private val traceparent = "00-8f3ca4ed5a6b7c8d9e0f112233445566-b7ad6b7169203331-01"

    @Test
    fun aLineIsTheOperationTheChannelAndThePayloadAsJsonOnOneLine() {
        val payload = JsonObject(
            mapOf(
                "resourceId" to JsonPrimitive("res-1"),
                "said" to JsonPrimitive("two\nlines"),
                "naïve" to JsonArray(listOf(JsonPrimitive(1), JsonObject(mapOf("left" to kotlinx.serialization.json.JsonNull, "right" to JsonPrimitive(true))))),
            ),
        )
        assertEquals(
            """[bus EMIT] beckon:focus {"resourceId":"res-1","said":"two\nlines","naïve":[1,{"left":null,"right":true}]}""",
            busLine(Logged.EMIT, "beckon:focus", payload, null, null, null),
        )
    }

    @Test
    fun aLineSaysTheScopeAndTheFirstEightOfTheCorrelationIdAndOfTheTraceEachWhereThereIsOne() {
        val empty = JsonObject(emptyMap())
        val resource = ResourceId.parse("res-1")!!
        val correlation = "a89a670a-1b2c-4d3e-8f90-123456789abc"
        assertEquals("[bus RECV] mark:added scope=res-1 {}", busLine(Logged.RECV, "mark:added", empty, resource, null, null))
        assertEquals("[bus EMIT] job:claim cid=a89a670a {}", busLine(Logged.EMIT, "job:claim", empty, null, correlation, null))
        // A correlation id that is nothing is none.
        assertEquals("[bus EMIT] job:claim {}", busLine(Logged.EMIT, "job:claim", empty, null, "", null))
        assertEquals("[bus GET] content trace=8f3ca4ed {}", busLine(Logged.GET, "content", empty, null, null, traceparent))
        assertEquals(
            "[bus RECV] mark:added scope=res-1 cid=a89a670a trace=8f3ca4ed {}",
            busLine(Logged.RECV, "mark:added", empty, resource, correlation, traceparent),
        )
    }

    @Test
    fun theNamesWithheldUnderAreTheTables() {
        assertEquals(names.toSet(), CREDENTIAL_NAMES)
    }

    @TestFactory
    fun aLineShowsOfAPayloadWhatTheTableSays(): List<DynamicTest> = cases.map { case ->
        DynamicTest.dynamicTest(case.getValue("why").jsonPrimitive.content) {
            val shown = shown(case.getValue("payload"))
            assertTrue(sameJson(case.getValue("shown"), shown), "shown $shown")
        }
    }

    /** The names a case withholds under: each member it shows as withheld whose value was not that text already. */
    private fun withheld(payload: JsonElement, shown: JsonElement): Set<String> = when {
        payload is JsonObject && shown is JsonObject -> payload.keys.flatMap { name ->
            val was = payload.getValue(name)
            val now = shown.getValue(name)
            if (now == JsonPrimitive("[withheld]") && was != now) listOf(name) else withheld(was, now).toList()
        }.toSet()
        payload is JsonArray && shown is JsonArray -> payload.indices.flatMap { withheld(payload[it], shown[it]) }.toSet()
        else -> emptySet()
    }

    @Test
    fun theTablesCasesWithholdUnderEachOfItsNamesAndUnderNoOther() {
        val under = cases.flatMap { withheld(it.getValue("payload"), it.getValue("shown")) }.toSet()
        assertEquals(names.toSet(), under)
    }

    /** The registry's channel of `name`, as the SDK has it. */
    private fun channelNamed(name: String): Any = Channels::class.java.fields.map { it.get(null) }
        .single { (it is Channel<*> && it.name == name) || (it is ScopedChannel<*> && it.name == name) }

    @TestFactory
    fun aCaseThatNamesAChannelIsAPayloadThatChannelCarries(): List<DynamicTest> = cases.filter { "channel" in it }.map { case ->
        val name = case.getValue("channel").jsonPrimitive.content
        DynamicTest.dynamicTest(name) {
            val payload = case.getValue("payload").jsonObject
            when (val channel = channelNamed(name)) {
                is Channel<*> -> decoded(channel, payload)
                is ScopedChannel<*> -> decoded(channel, payload)
            }
        }
    }
}
