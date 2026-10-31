package semiont.annotations

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.Spec
import semiont.identifiers.ResourceId
import semiont.sameJson
import semiont.types.AgentSoftware
import semiont.types.AnnotationTarget
import semiont.types.Motivation
import java.util.Random

/** What `reconcile` gave, as the table writes it: a member for each thing the span has, and none for what it lacks. */
private fun asTheTableWrites(found: ReconciledSpan?): JsonElement {
    if (found == null) return JsonNull
    val span = found.span
    val written = mutableMapOf<String, JsonElement>(
        "start" to JsonPrimitive(span.start),
        "end" to JsonPrimitive(span.end),
        "exact" to JsonPrimitive(span.exact),
        "anchorMethod" to JsonPrimitive(found.anchorMethod.value),
    )
    span.prefix?.let { written["prefix"] = JsonPrimitive(it) }
    span.suffix?.let { written["suffix"] = JsonPrimitive(it) }
    (found.anchorMethod as? AnchorMethod.FuzzyMatch)?.let { written["matchQuality"] = JsonPrimitive(it.quality.value) }
    return JsonObject(written)
}

/** The edit distance, worked out in full. */
private fun edits(one: IntArray, other: IntArray): Int {
    var row = IntArray(other.size + 1) { it }
    for (i in 1..one.size) {
        val above = row
        row = IntArray(other.size + 1)
        row[0] = i
        for (j in 1..other.size) row[j] = minOf(above[j] + 1, row[j - 1] + 1, above[j - 1] + if (one[i - 1] == other[j - 1]) 0 else 1)
    }
    return row[other.size]
}

/** The loose search as the table states it: every stretch compared, one at a time. */
private fun nearestByTheTablesWords(content: IntArray, exact: IntArray): Pair<Int, Int>? {
    val allowance = exact.size / 20
    // With no allowance a stretch would have to be `exact` itself, which is found by what comes before this search.
    if (allowance == 0) return null
    var best: Pair<List<Int>, Pair<Int, Int>>? = null
    for (start in 0..content.size) {
        // A stretch within the allowance is at most the allowance longer or shorter than `exact`.
        for (length in maxOf(0, exact.size - allowance)..exact.size + allowance) {
            if (start + length > content.size) break
            val distance = edits(exact, content.copyOfRange(start, start + length))
            if (distance > allowance) continue
            // The least distance; of several the first in the text; from one start the nearest in length; of two as near, the shorter.
            val order = listOf(distance, start, kotlin.math.abs(length - exact.size), length)
            val held = best
            if (held == null || compareValuesBy(order, held.first, { it[0] }, { it[1] }, { it[2] }, { it[3] }) < 0) best = order to (start to start + length)
        }
    }
    return best?.second
}

/** `reconcile`, held to specs/src/annotations/reconcile-cases.json: the table every SDK's reconciling runs. */
class ReconcileCasesTest {
    private val cases: List<JsonObject> = Spec.read("annotations/reconcile-cases.json").jsonObject.getValue("cases").jsonArray.map { it.jsonObject }
    private val found = cases.mapNotNull { it["reconciled"] as? JsonObject }

    private fun quoted(case: JsonObject): QuotedText {
        val stated = case.getValue("quoted").jsonObject
        assertTrue(stated.keys.all { it in setOf("exact", "prefix", "suffix") }, "${stated.keys}")
        fun text(name: String) = stated[name]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content
        return QuotedText(checkNotNull(text("exact")), text("prefix"), text("suffix"))
    }

    private fun JsonObject.text(name: String) = getValue(name).jsonPrimitive.content

    @Test
    fun theRunnerFoundTheTablesCases() {
        assertTrue(cases.size >= 89)
    }

    @TestFactory
    fun aQuoteIsReconciledAsTheTableSays(): List<DynamicTest> = cases.map { case ->
        DynamicTest.dynamicTest(case.text("why")) {
            assertEquals(setOf("why", "text", "quoted", "reconciled"), case.keys)
            val given = asTheTableWrites(reconcile(case.text("text"), quoted(case)))
            assertTrue(sameJson(case.getValue("reconciled"), given), "reconciled as $given")
        }
    }

    @Test
    fun howASpanWasFoundIsOneOfTheWaysTheTableStatesAndNoOther() {
        val ways = listOf(AnchorMethod.UniqueMatch, AnchorMethod.ContextRecovered, AnchorMethod.FirstOfMany, AnchorMethod.FuzzyMatch(MatchQuality.Fuzzy)).map { it.value }
        assertEquals(ways.sorted(), found.map { it.text("anchorMethod") }.toSet().sorted())
        assertEquals(MatchQuality.entries.map { it.value }.sorted(), found.mapNotNull { it["matchQuality"]?.jsonPrimitive?.content }.toSet().sorted())
    }

    @TestFactory
    fun aReconciledSpanIsOneTheBuilderTakesAsItIs(): List<DynamicTest> = cases.filter { it["reconciled"] is JsonObject }.map { case ->
        DynamicTest.dynamicTest(case.text("why")) {
            val span = checkNotNull(reconcile(case.text("text"), quoted(case))).span
            val built = annotationOfSpan(case.text("text"), span, ResourceId("res-1"), Motivation.Highlighting, AgentSoftware(name = "ollama gemma3"))
            val quote = checkNotNull(textQuoteSelector(checkNotNull((built.target as AnnotationTarget).selector)))
            assertEquals(Triple(span.exact, span.prefix, span.suffix), Triple(quote.exact, quote.prefix, quote.suffix))
        }
    }

    @Test
    fun whiteSpaceIsUnicodesAndNotTheJvmsOwn() {
        // The JVM takes the four separators U+001C to U+001F for white space, and Unicode's White_Space property does not.
        val separator = "\u001f"
        assertTrue(separator.single().isWhitespace())
        // So one is words to find, where a quote of white space alone is refused.
        val found = checkNotNull(reconcile("a${separator}b", QuotedText(separator)))
        assertEquals(Triple(1L, 2L, AnchorMethod.UniqueMatch), Triple(found.span.start, found.span.end, found.anchorMethod))
        assertNull(reconcile("a b", QuotedText(" ")))
        // And it is no run to collapse: the quote with a space where the text has one is not found by normalizing.
        assertNull(reconcile("one${separator}two three", QuotedText("one two three")))
    }

    @Test
    fun theLooseSearchGivesWhatComparingEveryStretchGives() {
        // The SDK works out only the distances that can be within the allowance. This is the table's rule, worked out in full.
        val chance = Random(20261009)
        val letters = codePointsOf("abab c😀")
        var foundAny = 0
        repeat(60) {
            val content = IntArray(15 + chance.nextInt(55)) { letters[chance.nextInt(letters.size)] }
            val size = listOf(19, 20, 21, 26, 40, 41)[chance.nextInt(6)]
            val at = chance.nextInt(maxOf(1, content.size - size))
            val quote = content.copyOfRange(at, minOf(content.size, at + size)).toMutableList()
            repeat(chance.nextInt(4)) {
                val where = chance.nextInt(quote.size + 1)
                when (chance.nextInt(3)) {
                    0 -> quote.add(where, letters[chance.nextInt(letters.size)])
                    1 -> if (where < quote.size) quote.removeAt(where)
                    else -> if (where < quote.size) quote[where] = letters[chance.nextInt(letters.size)] else quote.add(letters[chance.nextInt(letters.size)])
                }
            }
            val exact = quote.toIntArray()
            val expected = nearestByTheTablesWords(content, exact)
            assertEquals(expected, nearestStretch(content, exact), "${content.text()} / ${exact.text()}")
            if (expected != null) foundAny += 1
        }
        assertTrue(foundAny in 16..54, "the trial texts are all found or all refused: they tell nothing apart ($foundAny)")
    }
}
