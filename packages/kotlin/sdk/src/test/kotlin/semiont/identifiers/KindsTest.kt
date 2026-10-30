package semiont.identifiers

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import semiont.Spec
import semiont.types.wireJson

/** Each kind of id holds what specs/src/identifiers/kinds.json says it accepts and refuses, made, parsed and decoded alike. */
class KindsTest {
    private val kinds = Spec.read("identifiers/kinds.json").jsonObject.getValue("kinds").jsonArray.map { it.jsonObject }

    /** How each kind is made and parsed: a census of the kinds, held to the table below. */
    private val made: Map<String, (String) -> Any> = mapOf("ResourceId" to ::ResourceId, "AnnotationId" to ::AnnotationId, "JobId" to ::JobId, "UserId" to ::UserId)
    private val parsed: Map<String, (String) -> Any?> =
        mapOf("ResourceId" to ResourceId::parse, "AnnotationId" to AnnotationId::parse, "JobId" to JobId::parse, "UserId" to UserId::parse)

    private fun decoded(kind: String, id: String): Any {
        val type: KSerializer<Any> = serializer(Class.forName("semiont.identifiers.$kind"))
        return wireJson.decodeFromString(type, JsonPrimitive(id).toString())
    }

    private fun cases(kind: Map<String, *>, said: String): List<String> =
        (kind.getValue(said) as kotlinx.serialization.json.JsonArray).map { it.jsonObject.getValue("id").jsonPrimitive.content }

    @Test
    fun everyKindTheTableNamesIsMadeAndParsedHere() {
        val named = kinds.map { it.getValue("schema").jsonPrimitive.content }.toSet()
        assertEquals(named, made.keys)
        assertEquals(named, parsed.keys)
    }

    @Test
    fun eachKindAcceptsWhatItsRuleAccepts() {
        var held = 0
        for (kind in kinds) {
            val name = kind.getValue("schema").jsonPrimitive.content
            for (id in cases(kind, "accepts")) {
                val id1 = made.getValue(name)(id)
                assertEquals(id1, parsed.getValue(name)(id), "$name.parse(\"$id\")")
                assertEquals(id1, decoded(name, id), "$name decoded from \"$id\"")
                assertEquals(id, id1.toString(), "$name(\"$id\") as text")
                held += 1
            }
        }
        assertTrue(held >= 8)
    }

    @Test
    fun eachKindRefusesWhatItsRuleRefuses() {
        var held = 0
        for (kind in kinds) {
            val name = kind.getValue("schema").jsonPrimitive.content
            for (id in cases(kind, "refuses")) {
                val refused = assertThrows(InvalidIdentifier::class.java, { made.getValue(name)(id) }, "$name(\"$id\")")
                assertEquals(name, refused.kind)
                assertEquals(id, refused.value)
                assertNull(parsed.getValue(name)(id), "$name.parse(\"$id\")")
                assertThrows(SerializationException::class.java, { decoded(name, id) }, "$name decoded from \"$id\"")
                held += 1
            }
        }
        assertTrue(held >= 8)
    }

    @Test
    fun aRefusalSaysTheRuleItWasHeldTo() {
        val refused = assertThrows(InvalidIdentifier::class.java) { ResourceId("a b") }
        assertEquals(ResourceId.PATTERN, refused.pattern)
        assertEquals(Spec.read("components/schemas/ResourceId.json").jsonObject.getValue("pattern").jsonPrimitive.content, ResourceId.PATTERN)
    }
}
