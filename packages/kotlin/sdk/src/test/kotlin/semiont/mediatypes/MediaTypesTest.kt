package semiont.mediatypes

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
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

/** The rules read from the media types a knowledge base admits, as every SDK reads them (specs/src/media-types/cases.json). */
class MediaTypesTest {
    private val table = Spec.read("media-types/cases.json").jsonObject
    private val registry = Spec.read("media-types/registry.json").jsonObject

    private fun rows(name: String) = table.getValue(name).jsonArray.map { it.jsonObject }

    private fun JsonObject.text(name: String) = getValue(name).jsonPrimitive.content

    @TestFactory
    fun aCloneTakesTheFormatTheTableSays(): List<DynamicTest> = rows("cloneFormat").map { row ->
        DynamicTest.dynamicTest(row.text("why")) {
            val source = row.getValue("source").takeUnless { it is JsonNull }?.jsonPrimitive?.content
            assertEquals(row.text("format"), cloneFormat(source).mediaType)
        }
    }

    @TestFactory
    fun contentIsStoredUnderTheNameTheTableSays(): List<DynamicTest> = rows("storageFileName").map { row ->
        DynamicTest.dynamicTest(row.text("why")) {
            val kind = checkNotNull(capabilitiesOf(row.text("format")))
            assertEquals(row.text("fileName"), storageFileName(row.text("name"), kind))
            assertEquals("file://${row.text("fileName")}", storageUri(row.text("name"), kind))
        }
    }

    @TestFactory
    fun whereATypesTextComesFromAndWhatFollowsFromItAreWhatTheTableSays(): List<DynamicTest> = rows("textSource").map { row ->
        DynamicTest.dynamicTest(row.text("why")) {
            // A member this does not read would be a rule this SDK is not held to.
            assertEquals(setOf("why", "format", "textSource", "yieldsGeometry", "derivesText"), row.keys)
            val format = row.text("format")
            assertEquals(row.text("textSource"), textSourceOf(format).word)
            assertEquals(row.getValue("yieldsGeometry").jsonPrimitive.boolean, yieldsGeometryOf(format))
            assertEquals(row.getValue("derivesText").jsonPrimitive.boolean, derivesTextOf(format))
        }
    }

    @Test
    fun theTableWasRead() {
        assertTrue(rows("cloneFormat").size >= 7 && rows("storageFileName").size >= 7)
        // What the cases of where a text comes from must tell apart: each of the registry's words for it, each answer
        // for a type the registry lacks, and a format from its parameters and its case.
        val sources = rows("textSource").map { it.text("format") to it.text("textSource") }
        assertEquals(TextSource.entries.map { it.word }.toSet(), sources.map { it.second }.toSet())
        assertEquals(setOf("decode", "none"), sources.filter { capabilitiesOf(it.first) == null }.map { it.second }.toSet())
        assertTrue(sources.any { (format, _) -> format != baseMediaType(format) })
    }

    @Test
    fun thisSdksRowsAreTheRegistrys() {
        val stated = registry.getValue("mediaTypes").jsonArray.map { it.jsonObject }.map {
            listOf(it.text("mediaType"), it.text("extension"), it.text("textSource"), it.getValue("authorable").jsonPrimitive.boolean, it.getValue("generatable").jsonPrimitive.boolean)
        }
        assertEquals(stated, MEDIA_TYPES.map { listOf(it.mediaType, it.extension, it.textSource.word, it.authorable, it.generatable) })
    }

    @Test
    fun whereATypesTextComesFromIsOneOfTheRegistrysWordsAndEachWordIsSomeRows() {
        val words = TextSource.entries.map { it.word }
        assertEquals(registry.getValue("textSource").jsonArray.map { it.jsonPrimitive.content }, words)
        // Each word is some row's, so the rows above tell each from the others.
        assertEquals(TextSource.entries.toSet(), MEDIA_TYPES.map { it.textSource }.toSet())
    }

    @Test
    fun aTypeTheRegistryHasAnswersWhereItsTextComesFromAsItsRowSays() {
        assertEquals(MEDIA_TYPES.map { it.textSource }, MEDIA_TYPES.map { textSourceOf(it.mediaType) })
    }

    @Test
    fun someTypesCanBeGeneratedAndSomeCannot() {
        assertEquals(setOf(true, false), MEDIA_TYPES.map { it.generatable }.toSet())
    }

    @Test
    fun aFormatIsReadWithoutItsParametersAndInLowerCase() {
        assertEquals("text/html", baseMediaType("Text/HTML; charset=iso-8859-1"))
        assertNull(capabilitiesOf("application/x-unheard-of"))
    }
}
