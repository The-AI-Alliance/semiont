package semiont.jobs

import io.opentelemetry.api.trace.Span
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import semiont.bus.OPERATIONS
import semiont.errors.SemiontError
import semiont.identifiers.ResourceId
import semiont.transport.Broadcast
import semiont.transport.ConnectionState
import semiont.transport.Events
import semiont.transport.Frame
import semiont.transport.FrameSink
import semiont.transport.PendingReply
import semiont.transport.ReplyRouter
import semiont.transport.ResourceHold
import semiont.transport.TraceContext
import semiont.transport.Transport
import semiont.transport.Watched
import semiont.transport.unsubscribed
import java.util.concurrent.CompletableFuture
import kotlin.coroutines.CoroutineContext

internal fun obj(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(
    pairs.associate { (name, value) ->
        name to when (value) {
            null -> JsonNull
            is JsonElement -> value
            is String -> JsonPrimitive(value)
            is Number -> JsonPrimitive(value)
            is Boolean -> JsonPrimitive(value)
            else -> error("no JSON for $value")
        }
    },
)

/** A running job as the dispatcher hands one out from a claim. */
internal fun running(jobId: String, jobType: String = "mark", metadata: JsonObject = obj(), params: JsonObject = obj()): JsonObject = obj(
    "status" to "running",
    "metadata" to JsonObject(
        obj("id" to jobId, "type" to jobType, "userId" to "did:web:kb.example:users:u", "created" to "2026-01-01T00:00:00.000Z", "retryCount" to 0, "maxRetries" to 1) + metadata,
    ),
    "params" to JsonObject(obj("resourceId" to "res-1") + params),
    "startedAt" to "2026-01-01T00:00:01.000Z",
    "progress" to obj(),
)

/** An announcement of a `mark` job of `motivation`, stating less than a job of it would: it is compared as it came. */
internal fun queued(motivation: String): JsonObject =
    obj("jobId" to "job-announced", "jobType" to "mark", "resourceId" to "res-9", "userId" to "did:web:kb.example:users:u", "params" to obj("motivation" to motivation))

/** An annotation as the wire carries one: already made, with its id. */
internal fun annotation(id: String): JsonObject = obj(
    "@context" to "http://www.w3.org/ns/anno.jsonld",
    "type" to "Annotation",
    "id" to id,
    "motivation" to "highlighting",
    "target" to obj("source" to "res-1", "selector" to obj("type" to "TextQuoteSelector", "exact" to "the words of $id")),
    "created" to "2026-01-01T00:00:00.000Z",
)

/** What the wire does to one request: its reply delivered, or lost. */
internal enum class Fault { DELIVER, DROP }

/**
 * A stand-in for the dispatcher, which answers claims, and for the record,
 * which acknowledges every commit and answers every question about an
 * annotation with it, unless a test has it do otherwise. `wire` is what
 * happens to each request's reply in turn, every reply delivered when it
 * says nothing; a dropped reply is an answer nobody receives. Its stream
 * names `channels`, every channel when none are given, and a frame sent on a
 * channel it names comes back to it. The dispatcher answers a claim in the
 * claim's trace. Replies come a turn after the request, on `clock`.
 */
internal class Desk(clock: CoroutineContext, private val wire: List<Fault> = emptyList(), private val channels: Collection<String>? = null) : Transport {
    /** The jobs the dispatcher hands out, in order: none pending once they are spent. */
    val offered = ArrayDeque<JsonObject>()

    /** The failures the dispatcher answers claims with first, in order. */
    val refusals = ArrayDeque<JsonObject>()

    /** Whether the record refuses each commit. */
    var refusingCommits = false

    /** The failure the record answers a question about an annotation with, by the annotation's id. */
    val askedOf = mutableMapOf<String, JsonObject>()

    /** The trace each claim was made in, in order: its id, or none. */
    val claimedIn = mutableListOf<String?>()

    /** Every frame emitted, in order: requests and what was only said. */
    val emitted = mutableListOf<Frame>()
    private var requests = 0

    val connection = MutableStateFlow(ConnectionState.Open)
    private val router = ReplyRouter()
    private val heard = mutableMapOf<String, Broadcast<Frame>>()
    private val arriving = CoroutineScope(SupervisorJob() + clock)
    private var bus: FrameSink? = null

    /** A broadcast the gateway relays to this worker. */
    fun relay(channel: String, payload: JsonObject): Unit = deliver(Frame(channel, payload))

    fun deliver(frame: Frame) {
        router.route(frame)
        synchronized(heard) { heard[frame.channel] }?.deliver(frame)
        bus?.deliver(frame)
    }

    /** What was said on `channel`, in order. */
    fun sent(channel: String): List<JsonObject> = emitted.filter { it.channel == channel }.map { it.payload }

    /** Everything said that is not a request: the lifecycle, in order. */
    fun said(): List<Pair<String, JsonObject>> = emitted.filter { it.channel !in OPERATIONS }.map { it.channel to it.payload }

    private fun answer(channel: String, payload: JsonObject): Pair<Boolean, JsonObject> = when (channel) {
        "job:claim" -> refusals.removeFirstOrNull()?.let { false to it }
            ?: offered.removeFirstOrNull()?.let { true to obj("response" to it) }
            ?: (false to obj("message" to "No pending job matches", "code" to "none-pending"))
        "mark:commit" -> if (refusingCommits) {
            false to obj("message" to "the record could not append")
        } else {
            val ids = payload.getValue("annotations").jsonArray.map { it.jsonObject.getValue("id") }
            true to obj("response" to obj("persisted" to ids.size, "annotationIds" to JsonArray(ids)))
        }
        "browse:annotation-requested" -> {
            val id = payload.getValue("annotationId").jsonPrimitive.content
            askedOf[id]?.let { false to it } ?: (true to obj("response" to obj("annotation" to annotation(id), "resource" to null, "resolvedResource" to null)))
        }
        else -> error("nothing is scripted to answer $channel")
    }

    override val baseUrl: String = "desk://dispatcher"
    override val state: Watched<ConnectionState> = Watched(connection) { it == ConnectionState.Closed }

    override suspend fun emit(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): Long? {
        val request = Frame(channel, payload, correlationId, scope)
        emitted += request
        val operation = OPERATIONS[channel]
        if (operation == null) {
            echo(request)
            return 1
        }
        val fault = if (wire.isEmpty()) Fault.DELIVER else wire[requests % wire.size]
        requests++
        val made = Span.current().spanContext
        val trace = made.takeIf { it.isValid }?.let { TraceContext("00-${it.traceId}-${it.spanId}-01") }
        if (channel == "job:claim") claimedIn += trace?.traceparent?.split('-')?.get(1)
        val (answered, said) = answer(channel, payload)
        val reply = Frame(if (answered) operation.result.name else operation.failure.name, said, correlationId, null, trace)
        echo(request)
        if (fault == Fault.DELIVER) arriving.launch { deliver(reply) }
        return 1
    }

    private fun echo(sent: Frame) {
        if (isSubscribed(sent.channel)) deliver(sent)
    }

    override fun emitFuture(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): CompletableFuture<Long?> =
        throw UnsupportedOperationException("the client emits by its own future")

    override fun frames(channel: String): Events<Frame> {
        if (!isSubscribed(channel)) throw unsubscribed(channel)
        return synchronized(heard) { heard.getOrPut(channel) { Broadcast() } }.listen()
    }

    override fun isSubscribed(channel: String): Boolean = channels == null || channel in channels

    override fun subscribeToResource(resourceId: ResourceId): ResourceHold = ResourceHold {}

    override fun failures(): Events<SemiontError> = Broadcast<SemiontError>().listen()

    override fun bridgeInto(bus: FrameSink) {
        this.bus = bus
    }

    override fun trackReply(correlationId: String, replyChannels: Collection<String>): PendingReply = router.track(correlationId, replyChannels)

    override fun close() {
        arriving.cancel()
        router.close()
        connection.value = ConnectionState.Closed
        synchronized(heard) { heard.values.toList() }.forEach { it.close() }
    }
}
