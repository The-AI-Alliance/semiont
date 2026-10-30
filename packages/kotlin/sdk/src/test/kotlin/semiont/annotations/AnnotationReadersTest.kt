package semiont.annotations

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
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
import semiont.sameJson
import semiont.types.Annotation
import semiont.types.AnnotationSelector
import semiont.types.TextQuoteSelector
import semiont.types.wireJson

private fun said(text: String?): JsonElement = text?.let(::JsonPrimitive) ?: JsonNull

private fun said(selector: AnnotationSelector?): JsonElement = selector?.let { wireJson.encodeToJsonElement(AnnotationSelector.serializer(), it) } ?: JsonNull

private fun said(quote: TextQuoteSelector?): JsonElement = quote?.let { wireJson.encodeToJsonElement(TextQuoteSelector.serializer(), it) } ?: JsonNull

/** What each reader the table names gives of an annotation, as the table writes it. */
private val READERS: Map<String, (Annotation) -> JsonElement> = mapOf(
    "bodySource" to { a -> said(bodySource(a.body)?.value) },
    "isBodyResolved" to { a -> JsonPrimitive(isBodyResolved(a.body)) },
    "targetSource" to { a -> said(targetSource(a.target).value) },
    "targetSelector" to { a -> said(targetSelector(a.target)) },
    "isHighlight" to { a -> JsonPrimitive(isHighlight(a)) },
    "isReference" to { a -> JsonPrimitive(isReference(a)) },
    "isAssessment" to { a -> JsonPrimitive(isAssessment(a)) },
    "isComment" to { a -> JsonPrimitive(isComment(a)) },
    "isTag" to { a -> JsonPrimitive(isTag(a)) },
    "commentText" to { a -> said(commentText(a)) },
    "isStubReference" to { a -> JsonPrimitive(isStubReference(a)) },
    "isResolvedReference" to { a -> JsonPrimitive(isResolvedReference(a)) },
    "exactText" to { a -> said(exactText(targetSelector(a.target))) },
    "annotationExactText" to { a -> said(annotationExactText(a)) },
    "textQuoteSelector" to { a -> said(textQuoteSelector(checkNotNull(targetSelector(a.target)) { "the table gives textQuoteSelector no selector to read" })) },
    "entityTypes" to { a -> JsonArray(entityTypes(a).map(::JsonPrimitive)) },
    "tagCategory" to { a -> said(tagCategory(a)) },
    "tagSchemaId" to { a -> said(tagSchemaId(a)) },
)

/** The readers of an annotation, held to specs/src/annotations/reader-cases.json. */
class AnnotationReadersTest {
    private val table = Spec.read("annotations/reader-cases.json").jsonObject
    private val readers = table.getValue("readers").jsonArray.map { it.jsonPrimitive.content }
    private val cases: List<JsonObject> = table.getValue("cases").jsonArray.map { it.jsonObject }

    private fun annotation(case: JsonObject) = wireJson.decodeFromJsonElement(Annotation.serializer(), case.getValue("annotation"))

    @Test
    fun thereIsAReaderHereForEachTheTableNamesAndNoOther() {
        assertEquals(readers.sorted(), READERS.keys.sorted())
        assertEquals(18, readers.size)
    }

    @Test
    fun everyCaseStatesEveryReaderButTheQuoteSelectorWhereThereIsNoSelector() {
        for (case in cases) {
            val applies = readers.filter { it != "textQuoteSelector" || targetSelector(annotation(case).target) != null }
            assertEquals(applies.sorted(), case.getValue("reads").jsonObject.keys.sorted(), case.getValue("why").jsonPrimitive.content)
        }
        assertTrue(cases.isNotEmpty())
    }

    @TestFactory
    fun everyReaderGivesWhatTheTableSays(): List<DynamicTest> = cases.map { case ->
        DynamicTest.dynamicTest(case.getValue("why").jsonPrimitive.content) {
            val annotation = annotation(case)
            for ((reader, answer) in case.getValue("reads").jsonObject) {
                val given = READERS.getValue(reader)(annotation)
                assertTrue(sameJson(answer, given), "$reader gave $given, not $answer")
            }
        }
    }
}
