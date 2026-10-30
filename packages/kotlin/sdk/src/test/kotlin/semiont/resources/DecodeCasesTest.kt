package semiont.resources

import kotlinx.coroutines.runBlocking
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
import semiont.Recording
import semiont.SemiontClient
import semiont.Spec
import semiont.errors.TransportError
import semiont.identifiers.ResourceId
import semiont.mediatypes.textSourceOf
import semiont.transport.Content

private val RESOURCE = ResourceId("res-1")
private val EVERY_BYTE = ByteArray(256) { it.toByte() }

private fun bytesOf(hexadecimal: String): ByteArray =
    if (hexadecimal.isEmpty()) ByteArray(0) else hexadecimal.split(' ').map { it.toInt(16).toByte() }.toByteArray()

/** What a client reads of some bytes, served with a content type. */
private fun read(contentType: String, data: ByteArray): String = runBlocking {
    val recording = Recording()
    recording.serves = Content(contentType, data)
    SemiontClient(recording, recording, recording).use { it.browse.resourceContent(RESOURCE) }
}

/** The reading is refused as a transport's failure, and the refusal names what it refuses: a label, or a media type. */
private fun refused(contentType: String, data: ByteArray, named: String) {
    val refusal = assertThrows(TransportError::class.java) { read(contentType, data) }
    assertEquals("error", refusal.code)
    assertTrue(named in refusal.message.orEmpty(), "the refusal names $named: ${refusal.message}")
}

/**
 * What text a resource's bytes are, held to the two tables every reader of a
 * resource's text runs: text/decode-cases.json, written by hand, and
 * text/encoding-cases.json, generated. A worker reads a resource's text with
 * `browse.resourceContent` and counts its offsets in what that gives, so each
 * case is read through a client, from bytes its content transport serves with
 * the case's content type.
 */
class DecodeCasesTest {
    private val cases: List<JsonObject> = Spec.read("text/decode-cases.json").jsonObject.getValue("cases").jsonArray.map { it.jsonObject }
    private val encodings: List<JsonObject> = Spec.read("text/encoding-cases.json").jsonObject.getValue("cases").jsonArray.map { it.jsonObject }

    private fun JsonObject.text(name: String) = getValue(name).jsonPrimitive.content

    private val labels: List<Pair<JsonObject, String>> = encodings.flatMap { stated -> stated.getValue("labels").jsonArray.map { stated to it.jsonPrimitive.content } }

    @Test
    fun theRunnerFoundTheTablesCases() {
        assertTrue(cases.size >= 90)
        // A refusal is of a charset, where the type is one that is decoded, or of the type itself: the table has one
        // whose text is derived from its bytes, and one with no text.
        assertEquals(setOf("decode", "pdf-text-layer", "none"), cases.filter { "refused" in it }.map { textSourceOf(it.text("contentType")).word }.toSet())
        assertTrue(encodings.count { "everyByte" in it } >= 29)
        assertTrue(encodings.any { "bytes" in it } && encodings.any { "refused" in it })
        assertTrue(labels.size >= 180)
    }

    @TestFactory
    fun aResourcesBytesAreTheTextTheTableSays(): List<DynamicTest> = cases.map { stated ->
        DynamicTest.dynamicTest(stated.text("why")) {
            val data = bytesOf(stated.text("bytes"))
            if ("refused" in stated) {
                assertEquals(setOf("why", "contentType", "bytes", "refused"), stated.keys)
                refused(stated.text("contentType"), data, stated.text("refused"))
            } else {
                assertEquals(setOf("why", "contentType", "bytes", "text"), stated.keys)
                assertEquals(stated.text("text"), read(stated.text("contentType"), data))
            }
        }
    }

    @TestFactory
    fun everyLabelOfTheStandardNamesItsEncodingAndEveryByteIsItsCharacter(): List<DynamicTest> = labels.map { (stated, label) ->
        DynamicTest.dynamicTest("${stated.text("encoding")}: $label") {
            val contentType = "text/plain; charset=$label"
            when {
                "everyByte" in stated -> assertEquals(stated.text("everyByte"), read(contentType, EVERY_BYTE))
                "bytes" in stated -> assertEquals(stated.text("text"), read(contentType, bytesOf(stated.text("bytes"))))
                else -> refused(contentType, EVERY_BYTE, label)
            }
        }
    }
}
