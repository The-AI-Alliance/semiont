package semiont.codegen

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull

/**
 * The code of the spec's tables beside its schemas: the bus registry's
 * channels, audiences, trace field and operations (bus/registry.json), the
 * timing a client keeps (client/timing.json), the codes its failures carry
 * (errors/codes.json), the media types a knowledge base admits
 * (media-types/registry.json), the Encoding Standard's labels and
 * single-byte encodings (text/encoding-cases.json), and what each event does
 * to a client's cache (client/refresh.json). Each refuses what it cannot
 * render.
 */
private fun JsonElement?.obj(what: String): JsonObject = this as? JsonObject ?: refuse("$what is no object")

private fun JsonElement?.list(what: String): JsonArray = this as? JsonArray ?: refuse("$what is no list")

private fun JsonElement?.text(what: String): String = (this as? JsonPrimitive)?.takeIf { it.isString }?.content ?: refuse("$what is no text")

/** `beckon:focus` as `BECKON_FOCUS`. */
internal fun constantName(name: String): String = name.uppercase().replace(Regex("[^A-Z0-9]+"), "_").trim('_')

/** A channel of the registry: its name, the Kotlin type of its payload and that type's serializer, the members beginning `_` its payload declares, and whether a resource's scope carries it. */
private class ChannelRow(val name: String, val type: String, val serializer: String, val stamps: Set<String>, val scoped: Boolean)

/** `#/definitions/Annotation` as `Annotation`. */
private fun referenced(schema: JsonObject): String? = (schema["\$ref"] as? JsonPrimitive)?.content?.let {
    it.removePrefix("#/definitions/").takeIf { name -> name != it } ?: refuse("\$ref $it is not a component schema")
}

/**
 * The members beginning `_` that a schema declares: an object's own, each of
 * an `allOf`'s members', and a union's, on which its members must agree: a
 * stamp is kept or dropped before a frame is read, so before it is known which
 * member the frame is.
 */
private fun stampsOf(definitions: JsonObject, what: String, schema: JsonObject): Set<String> {
    referenced(schema)?.let { return stampsOf(definitions, it, definitions[it].obj("the schema $it")) }
    (schema["oneOf"] ?: schema["anyOf"])?.let { members ->
        val each = members.list("$what's members").map { stampsOf(definitions, what, it.obj("a member of $what")) }
        if (each.distinct().size > 1) refuse("$what: its members do not declare the same stamps ($each)")
        return each.firstOrNull().orEmpty()
    }
    val own = (schema["properties"] as? JsonObject)?.keys.orEmpty().filter { it.startsWith("_") }
    val inherited = (schema["allOf"] as? JsonArray)?.flatMap { stampsOf(definitions, what, it.obj("an allOf member of $what")) }.orEmpty()
    return (own + inherited).toSet()
}

private fun channelRows(registry: JsonObject, definitions: JsonObject, scoped: Set<String>): List<ChannelRow> = registry["channels"].list("the registry's channels").map { raw ->
    val channel = raw.obj("a channel")
    val name = channel["channel"].text("a channel's name")
    fun schema(key: String): String = channel[key].text("$name's $key").also { if (it !in definitions) refuse("$name's $key $it is no schema") }
    fun stamps(schema: String): Set<String> = stampsOf(definitions, schema, definitions[schema].obj("the schema $schema"))
    when (val shape = channel["shape"].text("$name's shape")) {
        "schema" -> schema("schema").let { ChannelRow(name, it, "$it.serializer()", stamps(it), name in scoped) }
        "envelope" -> schema("schema").let { ChannelRow(name, "Response<$it>", "Response.serializer($it.serializer())", emptySet(), name in scoped) }
        "storedEvent" -> {
            schema("payload")
            val stored = if (channel["enriched"] == JsonPrimitive(true)) "EnrichedResourceEvent" else "StoredEventResponse"
            ChannelRow(name, stored, "$stored.serializer()", stamps(stored), name in scoped)
        }
        "empty", "void" -> ChannelRow(name, "Empty", "Empty.serializer()", emptySet(), name in scoped)
        else -> refuse("$name: a channel shape the generator does not know: $shape")
    }
}

/** The channels: one constant each, typed by its payload, the lists of the registry's audiences, and the trace field. */
internal fun channelsFile(registry: JsonObject, definitions: JsonObject): String = buildString {
    val names = registry["channels"].list("the registry's channels").map { it.obj("a channel")["channel"].text("a channel's name") }.toSet()
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
    val rows = channelRows(registry, definitions, scoped.toSet())
    val persisted = registry["channels"].list("the registry's channels").map { it.obj("a channel") }
        .filter { it["shape"].text("a channel's shape") == "storedEvent" }.map { it["event"].text("an event's type") }
    val trace = registry["trace"].obj("the registry's trace")["field"].text("the trace's field")
    if (!trace.startsWith("_")) refuse("the trace field $trace does not begin with `_`")

    append("/**\n * The field of a relayed frame's payload its trace rides in (the bus registry's `trace`).\n */\n")
    append("@Generated\npublic const val TRACE_FIELD: String = ${literal(trace)}\n\n")
    append("/** Every channel of the bus, by name, each typed by the payload a frame on it carries; a channel a resource's scope carries is a `ScopedChannel`. */\n")
    append("@Generated\npublic object Channels {\n")
    for (row in rows) {
        val kind = if (row.scoped) "ScopedChannel" else "Channel"
        val stamps = if (row.stamps.isEmpty()) "emptySet()" else "setOf(${row.stamps.sorted().joinToString(", ") { literal(it) }})"
        append("    @JvmField\n    public val ${constantName(row.name)}: $kind<${row.type}> = $kind(${literal(row.name)}, ${row.serializer}, $stamps)\n")
    }
    append("}\n\n")
    append("/** Every channel's name, in the registry's order. */\n")
    append("@Generated\npublic val CHANNEL_NAMES: List<String> = listOf(${rows.joinToString(", ") { literal(it.name) }})\n\n")
    append("/** What a client with no narrower list of its own subscribes to on no scope: the channels every client hears, and every operation's reply channels. */\n")
    append("@Generated\npublic val BRIDGED_CHANNELS: List<String> = listOf(${bridged.joinToString(", ") { literal(it) }})\n\n")
    append("/** The channels a resource's scope carries. */\n")
    append("@Generated\npublic val RESOURCE_SCOPED_CHANNELS: List<String> = listOf(${scoped.joinToString(", ") { literal(it) }})\n\n")
    append("/** The type of every event of the record. */\n")
    append("internal val PERSISTED: List<String> = listOf(${persisted.joinToString(", ") { literal(it) }})\n")
}

/** The operations: each typed by its three channels, what its reply states beside its response, and the operations that report inference limits. */
internal fun operationsFile(registry: JsonObject, definitions: JsonObject): String = buildString {
    val scoped = registry["audience"].obj("the registry's audience")["scoped"].list("the audience scoped").map { it.text("a scoped channel") }.toSet()
    val rows = channelRows(registry, definitions, scoped).associateBy { it.name }
    val channels = registry["channels"].list("the registry's channels").map { it.obj("a channel") }.associateBy { it["channel"].text("a channel's name") }
    fun channel(name: String): ChannelRow = (rows[name] ?: refuse("an operation names $name, which is no channel")).also {
        if (it.scoped) refuse("an operation names $name, which a resource's scope carries: a request and its replies go on no scope")
    }
    fun schemaOf(name: String): JsonObject? {
        val entry = channels.getValue(name)
        if (entry["shape"].text("$name's shape") != "schema") return null
        return definitions[entry["schema"].text("$name's schema")].obj("$name's schema")
    }
    val operations = registry["operations"].list("the registry's operations").map { it.obj("an operation") }
    append("/** Every operation of the registry, named for its request's channel, each typed by what it sends and what each reply carries. */\n")
    append("@Generated\npublic object Operations {\n")
    for (op in operations) {
        val request = op["request"].text("an operation's request")
        val result = op["result"].text("$request's result")
        val failure = op["failure"].text("$request's failure")
        val answered = schemaOf(result)
        if (answered != null && (answered["oneOf"] ?: answered["anyOf"]) != null) refuse("$result answers with one of several shapes: write what such a reply states beside its response")
        val named = (answered?.get("required") as? JsonArray)?.map { it.text("a required property") }?.filter { it != "response" }.orEmpty()
        if (named.isNotEmpty()) {
            val asked = schemaOf(request) ?: refuse("$result names $named beside its response, and $request has no schema to state them")
            for (property in named) {
                if ((asked["properties"] as? JsonObject)?.containsKey(property) != true) refuse("$result names $property beside its response, which $request does not state")
            }
        }
        val types = listOf(request, result, failure).joinToString(", ") { channel(it).type }
        val replyNames = if (named.isEmpty()) "emptyList()" else "listOf(${named.joinToString(", ") { literal(it) }})"
        append("    @JvmField\n    public val ${constantName(request)}: Operation<$types> =\n")
        append("        Operation(Channels.${constantName(request)}, Channels.${constantName(result)}, Channels.${constantName(failure)}, $replyNames)\n")
    }
    append("}\n\n")
    append("/** Each operation of the registry, by its request's channel. */\n")
    append("@Generated\npublic val OPERATIONS: Map<String, Operation<*, *, *>> = mapOf(\n")
    for (op in operations) {
        val request = op["request"].text("an operation's request")
        append("    ${literal(request)} to Operations.${constantName(request)},\n")
    }
    append(")\n\n")
    val limits = operations.filter { it["request"].text("an operation's request").endsWith(":limits-requested") }
    // Each asks the same and is answered the same, so one type holds them all, and a caller asks each without a cast.
    val limitsTypes = limits.map { op -> listOf("request", "result", "failure").joinToString(", ") { channel(op[it].text("a limits operation's $it")).type } }.distinct()
    val limitsType = limitsTypes.singleOrNull() ?: refuse("the limits operations are typed $limitsTypes: they must ask and answer alike")
    append("/** The operations that report the limits of the models a service holds credentials for. */\n")
    append("@Generated\npublic val LIMITS_OPERATIONS: List<Operation<$limitsType>> = listOf(${limits.joinToString(", ") { "Operations.${constantName(it["request"].text("an operation's request"))}" }})\n")
}

/** The telemetry the SDK's transports export: each span with its kind, and each metric, by its name in the table. */
internal fun telemetryFile(table: JsonObject): String = buildString {
    val kinds = mapOf("client" to "CLIENT", "server" to "SERVER", "producer" to "PRODUCER", "consumer" to "CONSUMER", "internal" to "INTERNAL")
    val taken = mutableSetOf<String>()
    fun constant(name: String): String = constantName(name.replace("{channel}", "")).also { if (!taken.add(it)) refuse("the telemetry table: two rows would both be $it") }
    append("/** The telemetry a Semiont SDK's transports export (specs/src/sdk-telemetry/telemetry.json). A span's name may hold `{channel}`, the bus channel. */\n")
    append("internal object TelemetryTable {\n")
    for (raw in table["spans"].list("the telemetry table's spans")) {
        val row = raw.obj("a span")
        val name = row["name"].text("a span's name")
        val kind = row["kind"].text("$name's kind").let { kinds[it] ?: refuse("$name: a span kind the generator does not know: $it") }
        append(kdoc("    ", row["meaning"].text("$name's meaning")))
        append("    val ${constant(name)}: SpanRow = SpanRow(${literal(name)}, SpanKind.$kind)\n")
    }
    for (raw in table["metrics"].list("the telemetry table's metrics")) {
        val row = raw.obj("a metric")
        val name = row["name"].text("a metric's name")
        val instrument = row["instrument"].text("$name's instrument")
        if (instrument != "counter") refuse("$name: an instrument the generator does not know: $instrument")
        val meaning = row["meaning"].text("$name's meaning")
        append(kdoc("    ", meaning))
        append("    val ${constant(name)}: MetricRow = MetricRow(${literal(name)}, ${literal(meaning)})\n")
    }
    append("}\n")
}

/** The names a credential goes by, which the bus log withholds the value of (bus/log-cases.json). */
internal fun credentialsFile(table: JsonObject): String = buildString {
    val names = table["names"].list("the bus log's names").map { it.text("a name") }
    if (names.isEmpty() || names.toSet().size != names.size) refuse("the bus log's names are none, or one is named twice")
    append("/** The names a credential goes by: a bus log line shows `[withheld]` for the value of a member under any of them (specs/src/bus/log-cases.json). */\n")
    append("internal val CREDENTIAL_NAMES: Set<String> = setOf(${names.joinToString(", ") { literal(it) }})\n")
}

/** The clients a Semiont client signs in as at a knowledge base's issuer, and the scope every sign-in asks for (session/oauth.json). */
internal fun oauthClientsFile(table: JsonObject): String = buildString {
    for (raw in table["clients"].list("the OAuth clients")) {
        val client = raw.obj("an OAuth client")
        val name = client["name"].text("a client's name")
        append(kdoc("", client["docs"].text("$name's docs")))
        append("@Generated\npublic const val ${constantName(name)}_CLIENT_ID: String = ${literal(client["id"].text("$name's id"))}\n\n")
    }
    val scope = table["scope"].obj("the sign-in scope")
    append(kdoc("", scope["docs"].text("the scope's docs")))
    append("@Generated\npublic const val SIGN_IN_SCOPE: String = ${literal(scope["value"].text("the scope's value"))}\n")
}

/**
 * How a writer keeps the sign-in store's directory to its owner (sign-in-store/owner-only.json): the mode, as the permissions a
 * POSIX file system names, and the access list Windows gives it, made for the user whose SID goes where the file's list says
 * `{owner}`.
 */
internal fun ownerOnlyFile(table: JsonObject): String = buildString {
    val mode = table["mode"].obj("the owner-only mode")
    val octal = mode["value"].text("the owner-only mode's value")
    if (!Regex("0[0-7]{3}").matches(octal)) refuse("the owner-only mode $octal is not four octal digits")
    val permissions = octal.drop(1).map { it.digitToInt() }.joinToString("") { bits ->
        "${if (bits and 4 != 0) 'r' else '-'}${if (bits and 2 != 0) 'w' else '-'}${if (bits and 1 != 0) 'x' else '-'}"
    }
    append(kdoc("", mode["docs"].text("the owner-only mode's docs")))
    append("internal const val OWNER_ONLY_PERMISSIONS: String = ${literal(permissions)}\n\n")
    val list = table["accessList"].obj("the owner-only access list")
    val parts = list["value"].text("the owner-only access list's value").split("{owner}")
    if (parts.size != 2) refuse("the owner-only access list names {owner} ${parts.size - 1} times, not once")
    append(kdoc("", list["docs"].text("the owner-only access list's docs").replace("`{owner}`", "`owner`")))
    append("internal fun ownerOnlyAccessList(owner: String): String = ${literal(parts[0])} + owner + ${literal(parts[1])}\n")
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
        append("/** $doc */\n@Generated\npublic enum class $name(\n    /** The code as the wire and every SDK spell it. */\n    public val code: String,\n) {\n")
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
    vocabulary("signIn", "SignInErrorCode", table["signIn"].obj("signIn")["docs"].text("signIn's docs"))
    vocabulary("session", "SessionErrorCode", table["session"].obj("session")["docs"].text("session's docs"))
    vocabulary("job", "JobErrorCode", table["job"].obj("job")["docs"].text("job's docs"))
    vocabulary("spanRefusal", "SpanRefusal", table["spanRefusal"].obj("spanRefusal")["docs"].text("spanRefusal's docs"))
    vocabulary("kbIdentity", "IdentityUnverifiableReason", table["kbIdentity"].obj("kbIdentity")["docs"].text("kbIdentity's docs"))
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

/**
 * The media types a knowledge base admits, with what this SDK reads of each:
 * a row's media type, its extension, where its text comes from, whether a
 * person authors it and whether a generation writes it. The registry's media
 * types are the `SupportedMediaType` enum's (`supported`), each once.
 */
internal fun mediaTypesFile(registry: JsonObject, supported: List<String>): String = buildString {
    val sources = registry["textSource"].list("the registry's textSource").map { it.text("a text source") }
    if (sources.isEmpty() || sources.toSet().size != sources.size) refuse("the registry's text sources are none, or one is stated twice")
    val rows = registry["mediaTypes"].list("the registry's media types").map { it.obj("a media type") }
    val stated = rows.map { it["mediaType"].text("a row's media type") }
    if (stated.toSet().size != stated.size) refuse("the registry states a media type twice")
    if (stated.toSet() != supported.toSet()) {
        refuse("the registry and SupportedMediaType disagree: ${(stated - supported.toSet()) + (supported - stated.toSet())}")
    }
    append("/** Where a type's text comes from: decoded from its own bytes, derived by reading them, or nowhere. */\n")
    append("internal enum class TextSource(\n    /** The word as the registry spells it. */\n    val word: String,\n) {\n")
    for (source in sources) append("    ${variantOf(source)}(${literal(source)}),\n")
    append("}\n\n")
    append("/** One media type a knowledge base admits. Its extension is the one a stored name takes, with its dot; an authorable type is offered where a person writes a resource; a generatable one the generation worker can produce. */\n")
    append("internal data class MediaType(val mediaType: String, val extension: String, val textSource: TextSource, val authorable: Boolean, val generatable: Boolean)\n\n")
    append("/** The registry, in its own order: ${rows.size} media types. */\n")
    append("internal val MEDIA_TYPES: List<MediaType> = listOf(\n")
    for (row in rows) {
        val type = row["mediaType"].text("a row's media type")
        if (type != type.lowercase() || ';' in type) refuse("$type is not a base media type: lower case, and no parameters")
        val extension = row["extension"].text("$type's extension")
        if (!Regex("^\\.[a-z0-9]+$").matches(extension)) refuse("$type's extension is $extension: a dot, then lower-case letters and digits")
        val source = row["textSource"].text("$type's text source")
        if (source !in sources) refuse("$type's text source is $source, which is none of $sources")
        fun flag(name: String) = (row[name] as? JsonPrimitive)?.booleanOrNull ?: refuse("$type does not say whether it is $name")
        append("    MediaType(${literal(type)}, ${literal(extension)}, TextSource.${variantOf(source)}, ${flag("authorable")}, ${flag("generatable")}),\n")
    }
    append(")\n")
}

/** `text` as a Kotlin string literal with every character but printable ASCII escaped, so each can be seen. */
private fun escaped(text: String): String = buildString {
    append('"')
    for (c in text) {
        when {
            c == '\\' -> append("\\\\")
            c == '"' -> append("\\\"")
            c == '$' -> append("\\$")
            c in ' '..'~' -> append(c)
            else -> append("\\u%04x".format(c.code))
        }
    }
    append('"')
}

/**
 * The Encoding Standard as a reader of a resource's text needs it: the
 * encoding each label names, the text each single-byte encoding's 256 bytes
 * are, and the encodings no text is read under. Each case of the table is one
 * of three: a single-byte encoding (`everyByte`), one told apart by some bytes
 * (`bytes` and `text`), or one whose labels are refused (`refused`).
 */
internal fun encodingsFile(table: JsonObject): String = buildString {
    val cases = table["cases"].list("the encoding cases").map { it.obj("an encoding case") }
    val labels = sortedMapOf<String, String>()
    val singleByte = linkedMapOf<String, String>()
    val refused = mutableListOf<String>()
    for (case in cases) {
        val encoding = case["encoding"].text("a case's encoding")
        if (encoding !in case["labels"].list("$encoding's labels").map { it.text("a label") }) refuse("$encoding is not among its own labels")
        for (label in case["labels"].list("$encoding's labels").map { it.text("a label of $encoding") }) {
            if (labels.put(label, encoding) != null) refuse("the label $label names two encodings")
        }
        when {
            "everyByte" in case -> {
                val bytes = case["everyByte"].text("$encoding's bytes")
                if (bytes.length != 256) refuse("$encoding gives ${bytes.length} characters for its 256 bytes")
                singleByte[encoding] = bytes
            }
            (case["refused"] as? JsonPrimitive)?.booleanOrNull == true -> refused += encoding
            "bytes" in case && "text" in case -> Unit
            else -> refuse("$encoding is neither single-byte, nor told apart by its bytes, nor refused")
        }
    }
    append("/** Every label of the Encoding Standard, with the encoding it names: ${labels.size} of them. */\n")
    append("internal val ENCODING_OF_LABEL: Map<String, String> = mapOf(\n")
    for ((label, encoding) in labels) append("    ${escaped(label)} to ${escaped(encoding)},\n")
    append(")\n\n")
    append("/** Each single-byte encoding: the text its 256 bytes are, in order, one character to a byte, and U+FFFD where it gives a byte none. */\n")
    append("internal val SINGLE_BYTE: Map<String, String> = mapOf(\n")
    for ((encoding, bytes) in singleByte) append("    ${escaped(encoding)} to ${escaped(bytes)},\n")
    append(")\n\n")
    append("/** The encodings the standard reads no text under: every label of each is refused. */\n")
    append("internal val REFUSED: Set<String> = setOf(${refused.joinToString(", ") { escaped(it) }})\n")
}

/**
 * What a client asks again for, and when (client/refresh.json): the live
 * queries, the triggers, and each trigger's rows. A row reaches `subject`
 * unless it says otherwise. A row that names a query the table lacks, or a
 * trigger that is neither `reopened` nor a channel of the registry, is refused.
 */
internal fun cacheRefreshFile(table: JsonObject, registry: JsonObject): String = buildString {
    val queries = table["queries"].list("the refresh table's queries").map { it.obj("a query") }
    val names = queries.map { it["name"].text("a query's name") }
    if (names.toSet().size != names.size) refuse("the refresh table names a query twice")
    val channels = registry["channels"].list("the registry's channels").map { it.obj("a channel")["channel"].text("a channel's name") }.toSet()
    append("/** The live queries a client's cache answers. */\n")
    append("internal enum class CacheQuery(\n    /** The query as the table names it. */\n    val wire: String,\n) {\n")
    for (query in queries) {
        append(kdoc("    ", query["docs"].text("a query's docs")))
        append("    ${variantOf(query["name"].text("a query's name"))}(${literal(query["name"].text("a query's name"))}),\n")
    }
    append("}\n\n")
    val rows = table["refresh"].list("the refresh table's rows").map { it.obj("a row") }
    val triggers = rows.map { it["on"].text("a row's trigger") }.distinct()
    for (trigger in triggers) if (trigger != "reopened" && trigger !in channels) refuse("$trigger is no channel of the registry")
    append("/** What each trigger is: a channel whose events are it, or `reopened`, the stream open again after a drop. */\n")
    append("internal enum class CacheRefreshTrigger(\n    /** The trigger as the table names it. */\n    val wire: String,\n) {\n")
    for (trigger in triggers) append("    ${variantOf(trigger)}(${literal(trigger)}),\n")
    append("}\n\n")
    append("/** Which keys a row acts on: `Subject`, the keys the event names; `Held`, every key the client holds. */\n")
    append("internal enum class CacheRefreshReach { Subject, Held }\n\n")
    append("/** Which of a split channel's two kinds of event a row is for. */\n")
    append("internal enum class CacheRefreshWhen { Enriched, Unenriched }\n\n")
    append("/** What one trigger does to the cache: what it asks for again, what it writes with the value the event carries, and what it says is gone. */\n")
    append("internal data class CacheRefresh(\n    val reach: CacheRefreshReach,\n    val refetches: List<CacheQuery>,\n    val writes: List<CacheQuery>,\n    val removes: List<CacheQuery>,\n    val whenIs: CacheRefreshWhen?,\n)\n\n")
    fun queriesOf(row: JsonObject, key: String, trigger: String): String {
        val named = (row[key] as? JsonArray)?.map { it.text("a query $trigger $key") } ?: emptyList()
        for (name in named) if (name !in names) refuse("$trigger $key $name, which is no query of the table")
        return named.joinToString(", ", "listOf(", ")") { "CacheQuery.${variantOf(it)}" }
    }
    append("/** Each trigger's rows: one, or one for each kind of event of a split channel. */\n")
    append("internal val CACHE_REFRESH: Map<CacheRefreshTrigger, List<CacheRefresh>> = mapOf(\n")
    for (trigger in triggers) {
        append("    CacheRefreshTrigger.${variantOf(trigger)} to listOf(\n")
        for (row in rows.filter { it["on"].text("a row's trigger") == trigger }) {
            val reach = when (val stated = (row["reach"] as? JsonPrimitive)?.content ?: "subject") {
                "subject" -> "Subject"
                "held" -> "Held"
                else -> refuse("$trigger reaches $stated, which is neither subject nor held")
            }
            val whenIs = when (val stated = (row["when"] as? JsonPrimitive)?.content) {
                null -> "null"
                "enriched" -> "CacheRefreshWhen.Enriched"
                "unenriched" -> "CacheRefreshWhen.Unenriched"
                else -> refuse("$trigger is for $stated events, which are neither enriched nor unenriched")
            }
            append("        CacheRefresh(CacheRefreshReach.$reach, ${queriesOf(row, "refetches", trigger)}, ${queriesOf(row, "writes", trigger)}, ${queriesOf(row, "removes", trigger)}, $whenIs),\n")
        }
        append("    ),\n")
    }
    append(")\n")
}
