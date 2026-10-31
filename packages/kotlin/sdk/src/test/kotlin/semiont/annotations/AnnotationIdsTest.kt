package semiont.annotations

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.Spec
import semiont.identifiers.AnnotationId
import semiont.identifiers.ResourceId
import semiont.types.Motivation
import semiont.types.wireJson

/** The id a builder gives an annotation, held to specs/src/annotations/id-cases.json. */
class AnnotationIdsTest {
    private val cases: List<JsonObject> = Spec.read("annotations/id-cases.json").jsonObject.getValue("cases").jsonArray.map { it.jsonObject }

    private fun JsonObject.text(name: String) = getValue(name).jsonPrimitive.content

    private fun motivation(case: JsonObject) = wireJson.decodeFromJsonElement(Motivation.serializer(), case.getValue("motivation"))

    @Test
    fun theRunnerFoundTheTablesCasesAndNoneStatesABodyThatIsNull() {
        assertTrue(cases.size >= 20)
        assertEquals(emptyList<String>(), cases.filter { it["body"] is kotlinx.serialization.json.JsonNull }.map { it.text("why") })
    }

    @TestFactory
    fun anAnnotationsIdIsWhatTheTableSays(): List<DynamicTest> = cases.map { case ->
        DynamicTest.dynamicTest(case.text("why")) {
            assertEquals(AnnotationId(case.text("id")), annotationIdFor(ResourceId(case.text("resourceId")), motivation(case), case.text("anchor"), case["body"]))
        }
    }

    @Test
    fun aWholeNumberIsItsDigitsHoweverItIsWritten() {
        // JSON has one kind of number: seven is 7 whether it is written 7 or 7.0.
        fun said(seven: String) = wireJson.parseToJsonElement("""{"type":"TextualBody","value":"seven","Value":$seven}""")
        assertEquals(annotationIdFor(ResourceId("res-1"), Motivation.Commenting, "0:1:a", said("7")), annotationIdFor(ResourceId("res-1"), Motivation.Commenting, "0:1:a", said("7.0")))
    }

    @Test
    fun aNumberThatIsNotWholeHasNoFormTheRuleStatesAndIsRefused() {
        val half = wireJson.parseToJsonElement("""{"type":"TextualBody","value":"half","Value":0.5}""")
        val refused = assertThrows(IllegalArgumentException::class.java) { annotationIdFor(ResourceId("res-1"), Motivation.Commenting, "0:1:a", half) }
        assertTrue("whole" in refused.message.orEmpty())
    }
}
