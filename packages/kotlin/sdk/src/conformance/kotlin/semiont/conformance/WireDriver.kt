package semiont.conformance

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/**
 * The Kotlin SDK's wire driver: the program the SDK conformance suite talks
 * to in the Kotlin SDK's place (tests/conformance/sdk/README.md, The driver
 * protocol). It has no operation yet, and answers each that it has none.
 */
public fun main() {
    println(JsonObject(mapOf("ready" to JsonPrimitive(true))))
    System.out.flush()
    while (true) {
        val line = readlnOrNull() ?: break
        if (line.isBlank()) continue
        val id = Json.parseToJsonElement(line).jsonObject.getValue("id")
        println(JsonObject(mapOf("id" to id, "unsupported" to JsonPrimitive(true))))
        System.out.flush()
    }
}
