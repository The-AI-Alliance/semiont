package semiont.conformance

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import semiont.bus.Bus
import semiont.http.HttpContentTransport
import semiont.http.HttpTransport
import semiont.http.Timing
import semiont.http.TokenRefresher
import semiont.identifiers.AnnotationId
import semiont.identifiers.JobId
import semiont.identifiers.ResourceId
import semiont.retry.RetryPolicy
import semiont.transport.ConnectionState
import semiont.transport.PutBinaryRequest
import semiont.transport.ResourceHold
import java.util.Base64

/**
 * The Kotlin SDK's wire driver: the program the SDK conformance suite talks
 * to in the Kotlin SDK's place (tests/conformance/sdk/README.md, The driver
 * protocol). It holds a transport, and reaches it only as an application
 * does, through what the SDK makes public.
 */
public fun main() {
    serve { abandon -> WireDriver(abandon) }
}

/** The refresher a case's renewals give the client: each time it is asked, the next of them, made the client's token; none once they run out. */
private class Renewals(tokens: List<String>, private val token: MutableStateFlow<String?>) : TokenRefresher {
    private val left = ArrayDeque(tokens)

    override suspend fun refresh(refused: String?): String? {
        val renewed = synchronized(left) { left.removeFirstOrNull() } ?: return null
        token.value = renewed
        return renewed
    }
}

private class Client(val token: MutableStateFlow<String?>, val transport: HttpTransport, val bus: Bus, val content: HttpContentTransport)

private class WireDriver(private val abandon: (Long) -> Boolean) : Driver {
    override val operations = setOf(
        "open", "close", "set-token", "listen", "subscribe-resource", "release-resource", "emit", "request", "abandon",
        "put", "upload", "get", "get-stream", "graph", "annotations", "anchored-text",
        "health", "status", "current-user", "media-token", "protected-resource-metadata", "sync",
    )

    private var client: Client? = null
    private val held = mutableMapOf<String, MutableList<ResourceHold>>()
    private var reported: ConnectionState? = null
    private val reporting = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val reporters = mutableListOf<Job>()

    private fun current(): Client = synchronized(this) { client } ?: throw Misuse("no transport is open")

    /** Report the state the transport is in, unless it is the one last reported. */
    private fun report(state: ConnectionState) {
        synchronized(this) {
            if (reported == state) return
            reported = state
        }
        Say.line(Say.of("state" to JsonPrimitive(state.wire)))
    }

    override suspend fun run(id: Long, op: String, args: JsonObject): JsonElement = when (op) {
        "open" -> open(args)
        "close" -> JsonNull.also { current().transport.close() }
        "set-token" -> JsonNull.also { current().token.value = args.text("token") }
        "listen" -> listen(args)
        "subscribe-resource" -> JsonNull.also {
            val text = args.text("resource")
            val hold = current().transport.subscribeToResource(resource(text, "resource"))
            synchronized(held) { held.getOrPut(text) { mutableListOf() } += hold }
        }
        "release-resource" -> JsonNull.also {
            val text = args.text("resource")
            val hold = synchronized(held) { held[text]?.removeLastOrNull() } ?: throw Misuse("nothing holds $text")
            hold.close()
        }
        "emit" -> emit(args)
        "request" -> request(args)
        "abandon" -> JsonNull.also { if (!abandon(args.count("request"))) throw Misuse("no such request is unsettled") }
        "put" -> put(id, args, reporting = false)
        "upload" -> put(id, args, reporting = true)
        "get", "get-stream" -> get(args, op == "get-stream")
        "graph" -> answered(current().content.getResourceGraph(resource(args.text("resource"), "resource")))
        "annotations" -> answered(current().content.getAnnotations(resource(args.text("resource"), "resource")))
        "anchored-text" -> answered(current().content.getAnchoredText(resource(args.text("resource"), "resource")))
        "media-token" -> answered(current().transport.getMediaToken(resource(args.text("resource"), "resource")))
        "health" -> answered(current().transport.healthCheck())
        "status" -> answered(current().transport.getStatus())
        "current-user" -> answered(current().transport.getCurrentUser())
        "protected-resource-metadata" -> answered(current().transport.getProtectedResourceMetadata())
        "sync" -> JsonNull.also { synchronized(this) { client }?.let { report(it.transport.state.value) } }
        else -> throw Misuse("$op is not an operation of this driver")
    }

    /** An answer the gateway gave, written back as the JSON it was. */
    private inline fun <reified T> answered(value: T): JsonElement = semiont.conformance.encode(value)

    private fun resource(text: String, name: String): ResourceId = ResourceId.parse(text) ?: throw Misuse("$name: $text is not a resource's id")

    /** The client's timing, with what the case overrides. */
    private fun timing(args: JsonObject): Timing {
        val stated = args["timing"] as? JsonObject ?: return Timing()
        var timing = Timing()
        for (name in stated.keys) {
            timing = when (name) {
                "reconnectMs" -> timing.copy(reconnectMs = stated.count(name))
                "lazyRemoveMs" -> timing.copy(lazyRemoveMs = stated.count(name))
                "lingerMs" -> timing.copy(lingerMs = stated.count(name))
                "seenEventIdsCount" -> timing.copy(seenEventIdsCount = stated.count(name).toInt())
                "emitRetry" -> {
                    val budget = stated.obj(name)
                    timing.copy(emitRetry = RetryPolicy(budget.count("attempts").toInt(), budget.count("initialDelayMs"), budget.count("maxDelayMs")))
                }
                else -> throw Misuse("this driver cannot override $name")
            }
        }
        return timing
    }

    private fun open(args: JsonObject): JsonElement {
        if (synchronized(this) { client } != null) throw Misuse("a transport is already open")
        val timing = timing(args)
        val token = MutableStateFlow<String?>(args.text("token"))
        val refresher = if ("renewals" in args) Renewals(args.texts("renewals"), token) else null
        val transport = HttpTransport(args.text("baseUrl"), token, args.texts("channels"), timing, refresher)
        // Taken at once, so every failure from the first request on is heard.
        val failures = transport.failures()
        synchronized(this) { client = Client(token, transport, Bus(transport), HttpContentTransport(transport)) }
        reporters += reporting.launch { transport.state.collect { report(it) } }
        reporters += reporting.launch { failures.collect { Say.line(Say.of("error" to failure(it))) } }
        return JsonNull
    }

    private fun listen(args: JsonObject): JsonElement {
        val channel = args.text("channel")
        val frames = current().transport.frames(channel)
        reporters += reporting.launch {
            frames.collect { frame ->
                val line = mutableMapOf<String, JsonElement>("channel" to JsonPrimitive(channel), "payload" to frame.payload)
                frame.correlationId?.let { line["correlationId"] = JsonPrimitive(it) }
                frame.scope?.let { line["scope"] = JsonPrimitive(it.value) }
                Say.line(Say.of("frame" to JsonObject(line)))
            }
        }
        return JsonNull
    }

    private suspend fun emit(args: JsonObject): JsonElement {
        val scope = args.optionalText("scope")?.let { resource(it, "scope") }
        val subscribers = current().bus.emitOn(args.text("channel"), args.obj("payload"), scope, args.optionalText("correlationId"))
        return if (subscribers == null) JsonObject(emptyMap()) else Say.of("subscribers" to JsonPrimitive(subscribers))
    }

    private suspend fun request(args: JsonObject): JsonElement {
        val operation = args.text("operation")
        val payload = args.obj("payload")
        val timeoutMs = args.count("timeoutMs")
        val response = try {
            current().bus.requestOf(operation, payload, timeoutMs)
        } catch (unknown: IllegalArgumentException) {
            throw Misuse(unknown.message ?: "$operation is not an operation of the registry")
        }
        return if (response == null) JsonObject(emptyMap()) else Say.of("response" to response)
    }

    private suspend fun put(id: Long, args: JsonObject, reporting: Boolean): JsonElement {
        val bytes = try {
            Base64.getDecoder().decode(args.text("bytes"))
        } catch (_: IllegalArgumentException) {
            throw Misuse("bytes is not base64")
        }
        val request = PutBinaryRequest(
            name = args.text("name"),
            file = bytes,
            format = args.text("format"),
            storageUri = args.text("storageUri"),
            entityTypes = if ("entityTypes" in args) args.texts("entityTypes") else emptyList(),
            language = args.optionalText("language"),
            sourceAnnotationId = args.optionalText("sourceAnnotationId")?.let { AnnotationId.parse(it) ?: throw Misuse("sourceAnnotationId: $it is not an annotation's id") },
            sourceResourceId = args.optionalText("sourceResourceId")?.let { resource(it, "sourceResourceId") },
            generationPrompt = args.optionalText("generationPrompt"),
            jobId = args.optionalText("jobId")?.let { JobId.parse(it) ?: throw Misuse("jobId: $it is not a job's id") },
            isDraft = if ("isDraft" in args) (args["isDraft"] as? JsonPrimitive)?.booleanOrNull ?: throw Misuse("isDraft must be a boolean") else null,
        )
        val upload = current().content.putBinary(request)
        try {
            if (reporting) {
                upload.progress.collect { progress ->
                    Say.line(Say.of("progress" to Say.of("upload" to JsonPrimitive(id), "bytesUploaded" to JsonPrimitive(progress.bytesUploaded), "totalBytes" to JsonPrimitive(progress.totalBytes))))
                }
            }
            return Say.of("resourceId" to JsonPrimitive(upload.await().resourceId.value))
        } finally {
            // An upload its caller gave up is closed with it.
            upload.close()
        }
    }

    private suspend fun get(args: JsonObject, asStream: Boolean): JsonElement {
        val id = resource(args.text("resource"), "resource")
        val (contentType, bytes) = if (asStream) {
            val stream = current().content.getBinaryStream(id)
            val read = java.io.ByteArrayOutputStream()
            stream.bytes.collect { read.write(it) }
            stream.contentType to read.toByteArray()
        } else {
            val content = current().content.getBinary(id)
            content.contentType to content.bytes
        }
        return Say.of("contentType" to JsonPrimitive(contentType), "bytes" to JsonPrimitive(Base64.getEncoder().encodeToString(bytes)))
    }

    override fun finish() {
        synchronized(this) { client }?.let {
            it.transport.close()
            it.content.close()
        }
        runBlocking { reporters.toList().joinAll() }
        reporting.cancel()
    }
}

/** A value of the SDK's, written as the JSON the wire carries it as. */
internal inline fun <reified T> encode(value: T): JsonElement {
    val serializer: KSerializer<T> = kotlinx.serialization.serializer()
    return wire.encodeToJsonElement(serializer, value)
}

/** How the driver writes the SDK's values: as the SDK writes them, defaults left out. */
internal val wire = kotlinx.serialization.json.Json { encodeDefaults = false }
