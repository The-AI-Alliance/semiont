package semiont.types

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import semiont.Spec
import semiont.sameJson
import kotlin.io.path.readText

/**
 * A client hands on what it was sent: every payload the three conformance
 * corpora carry, decoded as the type its channel's schema is and written back,
 * is the JSON it was. A `$var` in a corpus stands for an id, and is that id here.
 */
class RoundTripTest {
    private val corpora = listOf("sdk/wire", "sdk/live", "worker").map { Spec.conformance.resolve(it) }

    /** Each channel's payload schema, and where in a frame's payload a value of it is. */
    private val payloads: Map<String, Pair<String, (JsonElement) -> JsonElement?>> =
        Spec.read("bus/registry.json").jsonObject.getValue("channels").jsonArray.mapNotNull { entry ->
            val channel = entry.jsonObject
            val name = channel.getValue("channel").jsonPrimitive.content
            fun named(key: String) = channel.getValue(key).jsonPrimitive.content
            when (channel.getValue("shape").jsonPrimitive.content) {
                "schema" -> name to (named("schema") to { payload: JsonElement -> payload })
                "storedEvent" -> name to (named("payload") to { payload: JsonElement -> payload })
                "envelope" -> name to (named("schema") to { payload: JsonElement -> payload.jsonObject["response"] })
                else -> null
            }
        }.toMap()

    private fun withoutVars(value: JsonElement): JsonElement = when (value) {
        is JsonObject -> value["\$var"]?.let { JsonPrimitive(it.jsonPrimitive.content) } ?: JsonObject(value.mapValues { withoutVars(it.value) })
        is JsonArray -> JsonArray(value.map(::withoutVars))
        else -> value
    }

    private fun frames(value: JsonElement, found: MutableList<Pair<String, JsonElement>>) {
        when (value) {
            is JsonObject -> {
                val channel = value["channel"]
                val payload = value["payload"]
                if (channel is JsonPrimitive && channel.isString && payload != null) found += channel.content to payload
                value.values.forEach { frames(it, found) }
            }
            is JsonArray -> value.forEach { frames(it, found) }
            else -> Unit
        }
    }

    @Test
    fun everyPayloadTheCorporaCarryIsWrittenBackAsItWasRead() {
        val failed = mutableListOf<String>()
        var held = 0
        for (file in corpora.flatMap(Spec::jsonFiles)) {
            val found = mutableListOf<Pair<String, JsonElement>>()
            frames(kotlinx.serialization.json.Json.parseToJsonElement(file.readText()), found)
            for ((channel, payload) in found) {
                val (schema, at) = payloads[channel] ?: continue
                val read = at(withoutVars(payload)) ?: continue
                val type: KSerializer<Any> = serializer(Class.forName("semiont.types.$schema"))
                val written = runCatching { wireJson.encodeToJsonElement(type, wireJson.decodeFromJsonElement(type, read)) }
                held += 1
                written.fold(
                    { if (!sameJson(read, it)) failed += "${file.fileName} $channel: $read was written back as $it" },
                    { failed += "${file.fileName} $channel: $read was not read as a $schema: ${it.message}" },
                )
            }
        }
        assertEquals(emptyList<String>(), failed)
        assertTrue(held >= 250, "the corpora gave $held payloads: the walk is reading the wrong thing")
    }
}
