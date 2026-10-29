package semiont.codegen

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * The code of the spec's tables beside its schemas: the bus registry's
 * channels, audiences, trace field and operations (bus/registry.json), the
 * timing a client keeps (client/timing.json), and the codes its failures
 * carry (errors/codes.json). Each refuses what it cannot render.
 */
private fun JsonElement?.obj(what: String): JsonObject = this as? JsonObject ?: refuse("$what is no object")

private fun JsonElement?.list(what: String): JsonArray = this as? JsonArray ?: refuse("$what is no list")

private fun JsonElement?.text(what: String): String = (this as? JsonPrimitive)?.takeIf { it.isString }?.content ?: refuse("$what is no text")

/** `beckon:focus` as `BECKON_FOCUS`. */
internal fun constantName(name: String): String = name.uppercase().replace(Regex("[^A-Z0-9]+"), "_").trim('_')

/** A channel of the registry, and the schema its payload is, when it is one. */
private class ChannelRow(val name: String, val payload: String?)

private fun channelRows(registry: JsonObject): List<ChannelRow> = registry["channels"].list("the registry's channels").map { raw ->
    val channel = raw.obj("a channel")
    val name = channel["channel"].text("a channel's name")
    val payload = when (val shape = channel["shape"].text("$name's shape")) {
        "schema" -> channel["schema"].text("$name's schema")
        "storedEvent" -> channel["payload"].text("$name's payload")
        "empty", "void", "envelope" -> null
        else -> refuse("$name: a channel shape the generator does not know: $shape")
    }
    ChannelRow(name, payload)
}

/** The channels: one constant each, typed by its payload, the lists of the registry's audiences, and the trace field. */
internal fun channelsFile(registry: JsonObject, schemas: Set<String>): String = buildString {
    val rows = channelRows(registry)
    val names = rows.map { it.name }.toSet()
    val audience = registry["audience"].obj("the registry's audience")
    fun audienceOf(key: String): List<String> = audience[key].list("the audience $key").map { it.text("a channel of $key") }.onEach {
        if (it !in names) refuse("the audience $key names $it, which is no channel")
    }
    val operations = registry["operations"].list("the registry's operations").map { it.obj("an operation") }
    val replies = operations.flatMap { listOf(it["result"].text("an operation's result"), it["failure"].text("an operation's failure")) }
    val bridged = (audienceOf("everyone") + replies).distinct()
    val scoped = audienceOf("scoped")
    val both = bridged.intersect(scoped.toSet())
    if (both.isNotEmpty()) refuse("$both reach a client both everywhere and on a scope: a frame would arrive twice")
    val persisted = registry["channels"].list("the registry's channels").map { it.obj("a channel") }
        .filter { it["shape"].text("a channel's shape") == "storedEvent" }.map { it["event"].text("an event's type") }
    val trace = registry["trace"].obj("the registry's trace")["field"].text("the trace's field")
    if (!trace.startsWith("_")) refuse("the trace field $trace does not begin with `_`")

    append("/**\n * The field of a relayed frame's payload its trace rides in (the bus registry's `trace`).\n */\n")
    append("public const val TRACE_FIELD: String = ${literal(trace)}\n\n")
    append("/** Every channel of the bus, by name, each typed by its payload. */\n")
    append("public object Channels {\n")
    for (row in rows) {
        val type = row.payload?.also { if (it !in schemas) refuse("${row.name}'s payload $it is no schema") } ?: "JsonObject"
        val serializer = if (row.payload == null) "JsonObject.serializer()" else "$type.serializer()"
        append("    public val ${constantName(row.name)}: Channel<$type> = Channel(${literal(row.name)}, $serializer)\n")
    }
    append("}\n\n")
    append("/** Every channel's name, in the registry's order. */\n")
    append("public val CHANNEL_NAMES: List<String> = listOf(${rows.joinToString(", ") { literal(it.name) }})\n\n")
    append("/** What a client with no narrower list of its own subscribes to on no scope: the channels every client hears, and every operation's reply channels. */\n")
    append("public val BRIDGED_CHANNELS: List<String> = listOf(${bridged.joinToString(", ") { literal(it) }})\n\n")
    append("/** The channels a resource's scope carries. */\n")
    append("public val RESOURCE_SCOPED_CHANNELS: List<String> = listOf(${scoped.joinToString(", ") { literal(it) }})\n\n")
    append("/** The type of every event of the record. */\n")
    append("internal val PERSISTED: List<String> = listOf(${persisted.joinToString(", ") { literal(it) }})\n")
}

/** The operations: each request's result and failure channels, what a reply states beside its response, and the operations that report inference limits. */
internal fun operationsFile(registry: JsonObject, definitions: JsonObject): String = buildString {
    val channels = registry["channels"].list("the registry's channels").map { it.obj("a channel") }.associateBy { it["channel"].text("a channel's name") }
    fun schemaOf(channel: String): JsonObject? {
        val entry = channels[channel] ?: refuse("an operation names $channel, which is no channel")
        if (entry["shape"].text("$channel's shape") != "schema") return null
        return definitions[entry["schema"].text("$channel's schema")].obj("$channel's schema")
    }
    val operations = registry["operations"].list("the registry's operations").map { it.obj("an operation") }
    append("/** Each operation of the registry, by its request's channel. */\n")
    append("internal val OPERATIONS: Map<String, OperationChannels> = mapOf(\n")
    for (op in operations) {
        val request = op["request"].text("an operation's request")
        val result = op["result"].text("$request's result")
        val failure = op["failure"].text("$request's failure")
        append("    ${literal(request)} to OperationChannels(${literal(request)}, ${literal(result)}, ${literal(failure)}),\n")
    }
    append(")\n\n")
    append("/** What an operation's reply states beside its `response`, by the request's channel: each a property of the request, which the reply states again. */\n")
    append("internal val REPLY_NAMES: Map<String, List<String>> = mapOf(\n")
    for (op in operations) {
        val request = op["request"].text("an operation's request")
        val result = op["result"].text("$request's result")
        val named = (schemaOf(result)?.get("required") as? JsonArray)?.map { it.text("a required property") }?.filter { it != "response" }.orEmpty()
        if (named.isEmpty()) continue
        val asked = schemaOf(request) ?: refuse("$result names $named beside its response, and $request has no schema to state them")
        for (property in named) {
            if ((asked["properties"] as? JsonObject)?.containsKey(property) != true) refuse("$result names $property beside its response, which $request does not state")
        }
        append("    ${literal(request)} to listOf(${named.joinToString(", ") { literal(it) }}),\n")
    }
    append(")\n\n")
    val limits = operations.map { it["request"].text("an operation's request") }.filter { it.endsWith(":limits-requested") }
    append("/** The operations that report the limits of the models a service holds credentials for. */\n")
    append("internal val LIMITS_OPERATIONS: List<String> = listOf(${limits.joinToString(", ") { literal(it) }})\n")
}

/** The timing a client keeps: each row a constant, `busRequestTimeoutMs` as `BUS_REQUEST_TIMEOUT_MS`, a budget as a `RetryPolicy`. */
internal fun timingFile(table: JsonObject): String = buildString {
    append("/** The timing a client keeps (specs/src/client/timing.json). */\n")
    append("internal object Timings {\n")
    for (raw in table["timing"].list("the timing table")) {
        val row = raw.obj("a timing row")
        val name = row["name"].text("a timing row's name")
        val constant = constantName(name.replace(Regex("([a-z0-9])([A-Z])"), "$1_$2"))
        when (val value = row["value"]) {
            is JsonPrimitive -> {
                val number = value.longOrNull ?: refuse("$name: a value that is no whole number: $value")
                append("    const val $constant: Long = $number\n")
            }
            is JsonObject -> {
                fun part(key: String) = (value[key] as? JsonPrimitive)?.longOrNull ?: refuse("$name: no whole $key")
                append("    val $constant: RetryPolicy = RetryPolicy(attempts = ${part("attempts")}, initialDelayMs = ${part("initialDelayMs")}, maxDelayMs = ${part("maxDelayMs")})\n")
            }
            else -> refuse("$name: a value the generator does not know: $value")
        }
    }
    append("}\n")
}

/** The codes a client's failures carry: an enum per vocabulary of errors/codes.json, each value as the wire spells it. */
internal fun errorCodesFile(table: JsonObject): String = buildString {
    fun vocabulary(key: String, name: String, doc: String) {
        val codes = table[key].obj(key)["codes"].list("$key's codes").map { it.obj("a code of $key") }
        append("/** $doc */\npublic enum class $name(\n    /** The code as the wire and every SDK spell it. */\n    public val code: String,\n) {\n")
        val taken = mutableSetOf<String>()
        for (entry in codes) {
            val code = entry["code"].text("a code of $key")
            val constant = variantOf(code.substringAfter('.'))
            if (!taken.add(constant)) refuse("$key: two codes would both be $constant")
            append(kdoc("    ", (entry["docs"] as? JsonPrimitive)?.content))
            append("    $constant(${literal(code)}),\n")
        }
        append("}\n\n")
    }
    vocabulary("transport", "TransportErrorCode", "Why a transport failed a request: what a server refused, or that none answered.")
    vocabulary("busRequest", "BusRequestErrorCode", "Why a bus request did not resolve.")
    val transport = table["transport"].obj("transport")["codes"].list("transport's codes").map { it.obj("a transport code") }
    append("/** The code a refusal of `status` fails with. */\n")
    append("internal fun transportErrorCodeFor(status: Int): TransportErrorCode = when {\n")
    for (entry in transport) {
        val constant = variantOf(entry["code"].text("a code"))
        (entry["status"] as? JsonPrimitive)?.longOrNull?.let { append("    status == $it -> TransportErrorCode.$constant\n") }
    }
    for (entry in transport) {
        val constant = variantOf(entry["code"].text("a code"))
        (entry["statusFrom"] as? JsonPrimitive)?.longOrNull?.let { append("    status >= $it -> TransportErrorCode.$constant\n") }
    }
    val unclassified = table["transport"].obj("transport")["unclassified"].text("transport's unclassified")
    append("    else -> TransportErrorCode.${variantOf(unclassified)}\n}\n\n")
    val bus = table["busRequest"].obj("busRequest")
    append("/** The client code a failure's own wire code becomes. */\n")
    append("internal val BUS_REQUEST_CODE_BY_WIRE_CODE: Map<String, BusRequestErrorCode> = mapOf(\n")
    for (entry in bus["codes"].list("busRequest's codes").map { it.obj("a code") }) {
        val wire = (entry["wire"] as? JsonPrimitive)?.content ?: continue
        append("    ${literal(wire)} to BusRequestErrorCode.${variantOf(entry["code"].text("a code").substringAfter('.'))},\n")
    }
    append(")\n\n")
    val unrecognized = bus["unrecognizedFailure"].text("busRequest's unrecognizedFailure")
    append("/** The client code of a failure whose own code is none it knows. */\n")
    append("internal val UNRECOGNIZED_FAILURE: BusRequestErrorCode = BusRequestErrorCode.${variantOf(unrecognized.substringAfter('.'))}\n")
}
