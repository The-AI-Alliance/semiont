package semiont.annotations

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.Spec

/** Offsets in code points, held to specs/src/text/offset-cases.json: a text is as long as its code points, and a span is where its offsets say. */
class OffsetCasesTest {
    private val cases: List<JsonObject> = Spec.read("text/offset-cases.json").jsonObject.getValue("cases").jsonArray.map { it.jsonObject }

    private fun JsonObject.text(name: String) = getValue(name).jsonPrimitive.content

    private fun JsonObject.number(name: String) = getValue(name).jsonPrimitive.int

    @Test
    fun theRunnerFoundTheTablesCases() {
        assertTrue(cases.size >= 10)
        // What tells code points from UTF-16 units: a case whose text has a character outside the basic plane.
        assertTrue(cases.any { case -> case.text("text").length != case.number("codePoints") })
    }

    @TestFactory
    fun aTextIsAsLongAsItsCodePoints(): List<DynamicTest> = cases.map { case ->
        DynamicTest.dynamicTest(case.text("why")) { assertEquals(case.number("codePoints"), codePointsOf(case.text("text")).size) }
    }

    @TestFactory
    fun aSpanIsFoundAtItsOffsetsAndItsOffsetsGiveTheSpan(): List<DynamicTest> = cases.map { case ->
        DynamicTest.dynamicTest(case.text("why")) {
            val text = codePointsOf(case.text("text"))
            for (span in case.getValue("spans").jsonArray.map { it.jsonObject }) {
                val exact = codePointsOf(span.text("exact"))
                val found = places(text, exact)[span.number("occurrence") - 1]
                assertEquals(span.number("start") to span.number("end"), found to found + exact.size, "${span.text("exact")} found")
                assertEquals(span.text("exact"), text.text(span.number("start"), span.number("end")), "${span.text("exact")} read back")
            }
        }
    }
}
