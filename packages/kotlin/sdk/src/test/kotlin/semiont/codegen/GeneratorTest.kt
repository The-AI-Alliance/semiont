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

    /** A registry of `channels`, answered by `operations`, with `scoped` the channels a resource's scope carries. */
    private fun registry(channels: String, operations: String = "[]", scoped: String = "[]"): JsonObject =
        definitions("""{"channels":$channels,"audience":{"everyone":[],"scoped":$scoped},"operations":$operations,"trace":{"field":"_carried"}}""")

    private val bothKinds = """{
        "A":{"type":"object","properties":{"_userId":{"type":"string"},"kind":{"type":"string","enum":["a"]}}},
        "B":{"type":"object","properties":{"kind":{"type":"string","enum":["b"]}}},
        "Either":{"oneOf":[{"${'$'}ref":"#/definitions/A"},{"${'$'}ref":"#/definitions/B"}]},
        "Stored":{"type":"object","properties":{"_userId":{"type":"string"}}}
    }"""

    @Test
    fun aUnionWhoseMembersDeclareDifferentStampsIsRefused() {
        val said = assertThrows(Refused::class.java) {
            channelsFile(registry("""[{"channel":"x:either","shape":"schema","schema":"Either"}]"""), definitions(bothKinds))
        }.message.orEmpty()
        assertTrue(said.contains("Either") && said.contains("stamps"), said)
    }

    @Test
    fun aChannelCarriesTheStampsItsPayloadDeclares() {
        val code = channelsFile(registry("""[{"channel":"x:a","shape":"schema","schema":"A"},{"channel":"x:b","shape":"schema","schema":"B"}]"""), definitions(bothKinds))
        assertTrue(code.contains("""Channel<A> = Channel("x:a", A.serializer(), setOf("_userId"))"""), code)
        assertTrue(code.contains("""Channel<B> = Channel("x:b", B.serializer(), emptySet())"""), code)
    }

    @Test
    fun anOperationAnsweredOnAResourcesScopeIsRefused() {
        val said = assertThrows(Refused::class.java) {
            operationsFile(
                registry(
                    """[{"channel":"x:asked","shape":"schema","schema":"B"},{"channel":"x:done","shape":"storedEvent","event":"x:done","payload":"B"},{"channel":"x:failed","shape":"schema","schema":"B"}]""",
                    operations = """[{"request":"x:asked","result":"x:done","failure":"x:failed"}]""",
                    scoped = """["x:done"]""",
                ),
                definitions(bothKinds.replace("\"Stored\"", "\"StoredEventResponse\"")),
            )
        }.message.orEmpty()
        assertTrue(said.contains("x:done") && said.contains("scope"), said)
    }
}
