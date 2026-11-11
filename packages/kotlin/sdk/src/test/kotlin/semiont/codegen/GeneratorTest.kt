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

    /** A refresh table of `queries`, with the rows every table has: `reopened`'s and `unreadable`'s. */
    private fun refreshTable(queries: String): JsonObject =
        definitions("""{"queries":$queries,"refresh":[{"on":"reopened","reach":"held"},{"on":"unreadable","reach":"held"}]}""")

    /** The schemas a refresh table's values name: `B`, and `A`, whose member `m` is a list of text. */
    private val values = definitions("""{
        "A":{"type":"object","properties":{"m":{"type":"array","items":{"type":"string"}}}},
        "B":{"type":"object","properties":{"n":{"type":"string"}}}
    }""")

    /** The file the refresh table of `queries` generates, its values typed from `values`. */
    private fun refreshFile(queries: String): String =
        cacheRefreshFile(refreshTable(queries), registry("[]"), values, Generation(roots = values.keys, identifiers = emptySet()))

    private fun refusedRefresh(queries: String): String = assertThrows(Refused::class.java) { refreshFile(queries) }.message.orEmpty()

    @Test
    fun theQueriesAClientKeepsAreThoseTheTableMarksPersistedInItsOrderEachKeptPerItsPerAsItsValue() {
        val code = refreshFile(
            """[
                {"name":"b","per":"resource","persisted":true,"value":{"${'$'}ref":"B.json"},"docs":"B."},
                {"name":"c","per":"filters","value":{"${'$'}ref":"B.json"},"docs":"C."},
                {"name":"a","persisted":true,"value":{"${'$'}ref":"A.json#/properties/m"},"docs":"A."}
            ]""",
        )
        assertTrue(code.contains("    val b: Cache<ResourceId, semiont.types.B>\n"), code)
        assertTrue(code.contains("    val a: Cache<String, kotlin.collections.List<String>>\n"), code)
        assertFalse(code.contains("val c:"), code)
        val listed = "internal val PERSISTED_QUERIES: List<KeptQuery<*, *>> = listOf(\n" +
            "    KeptQuery(CacheQuery.B, ResourceId.serializer(), serializer<semiont.types.B>(), KeptCaches::b),\n" +
            "    KeptQuery(CacheQuery.A, WholeKeySerializer, serializer<kotlin.collections.List<String>>(), KeptCaches::a),\n" +
            ")\n"
        assertTrue(code.contains(listed), code)
    }

    @Test
    fun aQueryPersistedAnyWayButTrueIsRefused() {
        val said = refusedRefresh("""[{"name":"a","persisted":false,"value":{"${'$'}ref":"B.json"},"docs":"A."}]""")
        assertTrue(said.contains("a is persisted false"), said)
    }

    @Test
    fun aPersistedQueryKeptPerAnythingButAResourceAnAnnotationOrNothingIsRefused() {
        val said = refusedRefresh("""[{"name":"a","per":"filters","persisted":true,"value":{"${'$'}ref":"B.json"},"docs":"A."}]""")
        assertTrue(said.contains("kept per filters"), said)
    }

    @Test
    fun aPersistedQueryWhoseValueIsNoComponentNorOneMemberOfOneIsRefused() {
        val deeper = refusedRefresh("""[{"name":"a","persisted":true,"value":{"${'$'}ref":"A.json#/properties/m/items"},"docs":"A."}]""")
        assertTrue(deeper.contains("names no one member of A"), deeper)
        val absent = refusedRefresh("""[{"name":"a","persisted":true,"docs":"A."}]""")
        assertTrue(absent.contains("a's value"), absent)
    }
}
