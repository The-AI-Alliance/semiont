package semiont.types

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
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
 * corpora state, decoded as the type its channel's schema is and written back,
 * is the JSON it was. What a payload states is resolved as the suite resolves
 * it (tests/conformance/sdk/README.md, Values): `$var` is a value the suite
 * binds before a case begins or a `let` step binds, and `$join` the text its
 * parts make. A payload that captures what only a run tells (an unbound
 * `$var`, or `_`) states nothing to compare, and is passed over. A member that
 * a gateway stamps (its name begins with `_`) and the schema does not name is
 * ignored as it is read, and so is left out as it is written.
 */
class RoundTripTest {
    private val corpora = listOf("sdk/wire", "sdk/live", "worker").map { Spec.conformance.resolve(it) }

    /** The values the suite binds before every case begins, as values of their kinds. */
    private val bound: Map<String, JsonElement> =
        listOf("r1", "r2", "r3", "a1", "a2").associateWith { JsonPrimitive(it) } +
            listOf("client", "participant").associateWith { JsonPrimitive("did:web:example.org:users:$it") }

    /** Payloads the corpus sends to see a client refuse them, each with why. Each must still be refused. */
    private val refused: Map<Pair<String, String>, String> = mapOf(
        ("failure-codes.json" to """{"message":"a code from the future","code":"not-invented-yet"}""") to
            "a failure's code no client knows, which the case expects every client to reject",
        ("malformed-reply.json" to """{"response":{"status":"running","params":{"resourceId":"r1"}}}""") to
            "a reply missing what its schema requires, which the case expects a client to refuse",
    )

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

    /** `value` with what it states resolved, or null when part of it is known only to a run. */
    private fun resolved(value: JsonElement, names: Map<String, JsonElement>): JsonElement? = when (value) {
        is JsonObject -> when {
            "\$var" in value -> names[value.getValue("\$var").jsonPrimitive.content]
            "\$join" in value -> value.getValue("\$join").jsonArray.map { resolved(it, names) as? JsonPrimitive ?: return null }
                .joinToString("") { it.content }.let(::JsonPrimitive)
            else -> JsonObject(value.mapValues { resolved(it.value, names) ?: return null })
        }
        is JsonArray -> JsonArray(value.map { resolved(it, names) ?: return null })
        is JsonPrimitive -> if (value.isString && value.content == "_") null else value
    }

    /** Every frame a case states, with the names bound by its `let` steps so far. */
    private fun frames(value: JsonElement, names: MutableMap<String, JsonElement>, found: MutableList<Pair<String, JsonElement?>>) {
        when (value) {
            is JsonObject -> {
                (value["let"] as? JsonObject)?.forEach { (name, bound) -> resolved(bound, names)?.let { names[name] = it } }
                val channel = value["channel"]
                val payload = value["payload"]
                if (channel is JsonPrimitive && channel.isString && payload != null) found += channel.content to resolved(payload, names)
                value.values.forEach { frames(it, names, found) }
            }
            is JsonArray -> value.forEach { frames(it, names, found) }
            else -> Unit
        }
    }

    /** The members of `read` that `written` leaves out, by path: none, or stamps alone. */
    private fun leftOut(read: JsonElement, written: JsonElement, path: String = "$"): List<String> = when {
        read is JsonObject && written is JsonObject ->
            read.flatMap { (key, value) -> written[key]?.let { leftOut(value, it, "$path.$key") } ?: listOf("$path.$key") }
        read is JsonArray && written is JsonArray && read.size == written.size -> read.indices.flatMap { leftOut(read[it], written[it], "$path[$it]") }
        else -> emptyList()
    }

    /** `value` without the members at `paths`. */
    private fun without(value: JsonElement, paths: Set<String>, path: String = "$"): JsonElement = when (value) {
        is JsonObject -> JsonObject(value.filterKeys { "$path.$it" !in paths }.mapValues { (key, member) -> without(member, paths, "$path.$key") })
        is JsonArray -> JsonArray(value.mapIndexed { index, member -> without(member, paths, "$path[$index]") })
        else -> value
    }

    @Test
    fun everyPayloadTheCorporaStateIsWrittenBackAsItWasRead() {
        val failed = mutableListOf<String>()
        val stillRefused = mutableSetOf<Pair<String, String>>()
        var held = 0
        for (file in corpora.flatMap(Spec::jsonFiles)) {
            val found = mutableListOf<Pair<String, JsonElement?>>()
            frames(Json.parseToJsonElement(file.readText()), bound.toMutableMap(), found)
            for ((channel, payload) in found) {
                val (schema, at) = payloads[channel] ?: continue
                val read = payload?.let(at) ?: continue
                val type: KSerializer<Any> = serializer(Class.forName("semiont.types.$schema"))
                val key = file.fileName.toString() to read.toString()
                val written = runCatching { wireJson.encodeToJsonElement(type, wireJson.decodeFromJsonElement(type, read)) }
                if (key in refused) {
                    if (written.isSuccess) failed += "${key.first} $channel: $read is said to be refused, and was read as a $schema" else stillRefused += key
                    continue
                }
                held += 1
                written.fold(
                    { back ->
                        val stamps = leftOut(read, back).toSet()
                        val unstamped = stamps.filterNot { it.substringAfterLast('.').startsWith("_") }
                        if (unstamped.isNotEmpty()) failed += "${file.fileName} $channel: $read lost $unstamped, written back as $back"
                        else if (!sameJson(without(read, stamps), back)) failed += "${file.fileName} $channel: $read was written back as $back"
                    },
                    { failed += "${file.fileName} $channel: $read was not read as a $schema: ${it.message?.lineSequence()?.first()}" },
                )
            }
        }
        assertEquals(emptyList<String>(), failed)
        assertEquals(refused.keys, stillRefused, "a payload said to be refused was not found in the corpora")
        assertTrue(held >= 150, "the corpora gave $held payloads: the walk is reading the wrong thing")
    }
}
