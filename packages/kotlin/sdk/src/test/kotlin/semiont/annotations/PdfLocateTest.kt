package semiont.annotations

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.Spec
import semiont.types.AnchoredText
import semiont.types.PdfTextItem
import semiont.types.wireJson

/** Where a span of a PDF's text is on its pages, held to the `cases` of specs/src/annotations/pdf-locate-cases.json. */
class PdfLocateTest {
    private val cases: List<JsonObject> = Spec.read("annotations/pdf-locate-cases.json").jsonObject.getValue("cases").jsonArray.map { it.jsonObject }

    private fun rectangle(stated: JsonObject): Rectangle {
        fun number(name: String) = stated.getValue(name).jsonPrimitive.double
        return Rectangle(number("page"), number("x"), number("y"), number("width"), number("height"))
    }

    @Test
    fun theRunnerFoundTheTablesCases() {
        assertTrue(cases.size >= 15)
    }

    @TestFactory
    fun aSpanIsLocatedAsTheTableSays(): List<DynamicTest> = cases.map { case ->
        DynamicTest.dynamicTest(case.getValue("why").jsonPrimitive.content) {
            assertEquals(setOf("why", "anchored", "span", "overlapping", "rects", "fragments"), case.keys)
            val anchored = wireJson.decodeFromJsonElement(AnchoredText.serializer(), case.getValue("anchored"))
            val span = case.getValue("span").jsonObject
            val (overlapping, rectangles) = locate(anchored, span.getValue("start").jsonPrimitive.long, span.getValue("end").jsonPrimitive.long)
            assertEquals(case.getValue("overlapping").jsonArray.map { wireJson.decodeFromJsonElement(PdfTextItem.serializer(), it) }, overlapping, "the items the span overlaps")
            assertEquals(case.getValue("rects").jsonArray.map { rectangle(it.jsonObject) }, rectangles, "a rectangle for each line")
            assertEquals(case.getValue("fragments").jsonArray.map { it.jsonPrimitive.content }, rectangles.map(::fragmentOf), "each rectangle as a fragment")
        }
    }

    @Test
    fun aNumberTheJvmWouldWriteWithAnExponentIsWrittenAsADecimal() {
        // The JVM writes a number below a thousandth with an exponent (5.0E-5), and the rule is the shortest decimal.
        assertEquals("5.0E-5", 0.00005.toString())
        assertEquals("page=1&viewrect=72,700.25,0.00005,12", fragmentOf(Rectangle(1.0, 72.0, 700.25, 0.00005, 12.0)))
    }
}
