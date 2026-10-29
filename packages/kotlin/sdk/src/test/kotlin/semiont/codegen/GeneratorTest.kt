package semiont.codegen

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The generator knows the shapes the spec's schemas use and refuses any other:
 * a schema that grows a new shape fails the build, rather than generating
 * something wrong.
 */
class GeneratorTest {
    private fun definitions(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject

    private fun generated(json: String, identifiers: Set<String> = emptySet()): String =
        types(definitions(json), Generation(roots = definitions(json).keys, identifiers = identifiers))

    private fun refused(json: String, identifiers: Set<String> = emptySet()): String =
        assertThrows(Refused::class.java) { generated(json, identifiers) }.message.orEmpty()

    @Test
    fun aSchemaOfAShapeItDoesNotKnowFailsTheBuild() {
        val said = refused("""{"Thing":{"type":"object","properties":{"either":{"type":["string","integer"]}}}}""")
        assertTrue(said.contains("Thing.either"), said)
    }

    @Test
    fun aConstIsRefused() {
        val said = refused("""{"Thing":{"type":"object","properties":{"kind":{"type":"string","const":"x"}}}}""")
        assertTrue(said.contains("`const` is not OpenAPI 3.0"), said)
    }

    @Test
    fun aKindOfIdWithAPatternItCannotCheckIsRefused() {
        val said = refused("""{"ThingId":{"type":"string","pattern":"^(a|b)+$"}}""", identifiers = setOf("ThingId"))
        assertTrue(said.contains("ThingId"), said)
    }

    @Test
    fun twoPropertiesOfOneKotlinNameAreRefused() {
        val said = refused("""{"Thing":{"type":"object","properties":{"_userId":{"type":"string"},"userId":{"type":"string"}}}}""")
        assertTrue(said.contains("userId"), said)
    }

    @Test
    fun aKindOfIdIsAValueClassMadeOnlyThroughItsCheck() {
        val code = generated("""{"ThingId":{"type":"string","description":"A thing's id.","pattern":"^[A-Za-z0-9_-]{1,128}$"}}""", identifiers = setOf("ThingId"))
        assertTrue(code.contains("value class ThingId"), code)
        assertFalse(code.contains("typealias ThingId"), code)
    }
}
