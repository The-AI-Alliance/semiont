package semiont.annotations

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.Spec
import semiont.errors.SpanRefusal
import semiont.errors.SpanRefusedError
import semiont.identifiers.ResourceId
import semiont.sameJson
import semiont.types.Agent
import semiont.types.AnchoredText
import semiont.types.Annotation
import semiont.types.AnnotationBodies
import semiont.types.Motivation
import semiont.types.TextualBody
import semiont.types.wireJson
import java.time.Duration
import java.time.Instant

private val MOMENT = Regex("""\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z""")

/** What a case states of a built annotation: all of it but `created`, which is held here to be the moment it was built. */
private fun withoutItsMoment(built: Annotation): JsonObject {
    val written = wireJson.encodeToJsonElement(Annotation.serializer(), built).jsonObject
    val created = written.getValue("created").jsonPrimitive.content
    assertTrue(MOMENT.matches(created), "$created is not an RFC 3339 date-time in UTC to the millisecond")
    assertTrue(Duration.between(Instant.parse(created), Instant.now()).abs() < Duration.ofMinutes(1), "$created is not now")
    return JsonObject(written - "created")
}

/** The annotation builders, held to specs/src/annotations/builder-cases.json: an annotation of a span (`cases`), and one of a resource as a whole (`resources`). */
class AnnotationBuildersTest {
    private val table = Spec.read("annotations/builder-cases.json").jsonObject
    private val cases: List<JsonObject> = table.getValue("cases").jsonArray.map { it.jsonObject }
    private val resources: List<JsonObject> = table.getValue("resources").jsonArray.map { it.jsonObject }

    private fun JsonObject.text(name: String) = getValue(name).jsonPrimitive.content

    private fun JsonObject.why() = text("why")

    private fun motivation(case: JsonObject) = wireJson.decodeFromJsonElement(Motivation.serializer(), case.getValue("motivation"))

    private fun generator(case: JsonObject): Agent? = case["generator"]?.let { wireJson.decodeFromJsonElement(Agent.serializer(), it) }

    private fun body(case: JsonObject): AnnotationBodies? = case["body"]?.let { wireJson.decodeFromJsonElement(AnnotationBodies.serializer(), it) }

    /** A case's span. None where an offset is no whole number: a span here holds two, so such an offset is refused where the span would be made. */
    private fun span(case: JsonObject): TextSpan? {
        val stated = case.getValue("span").jsonObject
        fun words(name: String) = stated[name]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content
        return TextSpan(
            stated.getValue("start").jsonPrimitive.longOrNull ?: return null,
            stated.getValue("end").jsonPrimitive.longOrNull ?: return null,
            checkNotNull(words("exact")),
            words("prefix"),
            words("suffix"),
        )
    }

    private fun build(case: JsonObject, span: TextSpan): Annotation {
        val resourceId = ResourceId(case.text("resourceId"))
        val generator = checkNotNull(generator(case)) { "${case.why()}: a case of a span gives what made it" }
        return case["text"]?.let { annotationOfSpan(it.jsonPrimitive.content, span, resourceId, motivation(case), generator, body(case)) }
            ?: annotationOfSpan(wireJson.decodeFromJsonElement(AnchoredText.serializer(), case.getValue("anchored")), span, resourceId, motivation(case), generator, body(case))
    }

    @Test
    fun theTableHasItsCasesAndEachIsOfATextOrOfAPdfAndIsBuiltOrRefused() {
        assertTrue(cases.size >= 33 && resources.size >= 4)
        for (case in cases) {
            assertTrue(("text" in case) != ("anchored" in case), case.why())
            assertTrue(("annotation" in case) != ("refused" in case), case.why())
        }
    }

    @Test
    fun whatNoCaseCanStateIsTheMomentAnAnnotationWasBuilt() {
        val unstated = table.getValue("unstated").jsonObject
        assertEquals(listOf("created") to listOf("created"), unstated.getValue("cases").jsonArray.map { it.jsonPrimitive.content } to unstated.getValue("resources").jsonArray.map { it.jsonPrimitive.content })
    }

    @Test
    fun theBuildersTheTableNamesAreThese() {
        assertEquals(listOf("reconcile", "annotationOfSpan", "annotationOfResource"), table.getValue("builders").jsonArray.map { it.jsonPrimitive.content })
    }

    @TestFactory
    fun anAnnotationOfASpanIsBuiltAsTheTableSays(): List<DynamicTest> = cases.filter { "annotation" in it }.map { case ->
        DynamicTest.dynamicTest(case.why()) {
            val built = withoutItsMoment(build(case, checkNotNull(span(case))))
            assertTrue(sameJson(case.getValue("annotation"), built), "built as $built")
        }
    }

    @TestFactory
    fun aSpanThatIsNotTheTextsIsRefusedByTheNameTheTableGives(): List<DynamicTest> = cases.filter { "refused" in it }.map { case ->
        DynamicTest.dynamicTest(case.why()) {
            val span = span(case)
            if (span == null) {
                // A span here holds two whole numbers, so an offset that is none is refused where the span is made.
                assertEquals(SpanRefusal.SpanOutOfRange.code, case.text("refused"))
            } else {
                val refused = assertThrows(SpanRefusedError::class.java) { build(case, span) }
                assertEquals(case.text("refused"), refused.code)
            }
        }
    }

    @Test
    fun theRefusalsTheTableStatesAreTheVocabularyOfTheErrorCodesAndNoOther() {
        assertEquals(SpanRefusal.entries.map { it.code }.sorted(), cases.filter { "refused" in it }.map { it.text("refused") }.toSet().sorted())
    }

    @TestFactory
    fun anAnnotationOfAResourceIsBuiltAsTheTableSays(): List<DynamicTest> = resources.map { case ->
        DynamicTest.dynamicTest(case.why()) {
            val built = withoutItsMoment(annotationOfResource(ResourceId(case.text("resourceId")), motivation(case), generator(case), body(case)))
            assertTrue(sameJson(case.getValue("annotation"), built), "built as $built")
        }
    }

    @Test
    fun anOptionGivenAsNothingIsAnOptionNotGivenInWhatIsWrittenAndInTheId() {
        fun commented(body: TextualBody): JsonObject = withoutItsMoment(
            annotationOfSpan(
                "Ada Lovelace wrote the first algorithm.",
                TextSpan(0, 12, "Ada Lovelace", null, null),
                ResourceId("res-1"),
                Motivation.Commenting,
                checkNotNull(generator(cases.first())),
                body,
            ),
        )
        val withNothing = commented(TextualBody(value = "an author", purpose = null, format = null))
        assertEquals(JsonObject(mapOf("type" to JsonPrimitive("TextualBody"), "value" to JsonPrimitive("an author"))), withNothing.getValue("body"))
        assertEquals(withNothing, commented(TextualBody(value = "an author")))
    }
}
