package semiont.state

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import semiont.bus.OPERATIONS
import semiont.channels.BRIDGED_CHANNELS
import semiont.errors.SemiontError
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.identifiers.ResourceId
import semiont.transport.Broadcast
import semiont.transport.ConnectionState
import semiont.transport.Events
import semiont.transport.Frame
import semiont.transport.FrameSink
import semiont.transport.PendingReply
import semiont.transport.ReplyRouter
import semiont.transport.ResourceHold
import semiont.transport.Transport
import semiont.transport.Watched
import semiont.transport.unsubscribed
import java.util.concurrent.CompletableFuture
import kotlin.coroutines.CoroutineContext

/** How the gateway behind a case's transport answers what nothing was queued for (the table's `answers`). */
internal enum class Answers {
    /** Every request is refused at once. */
    REFUSES,

    /** Every request reaches the gateway, and its reply is lost on the way: a step answers instead. */
    NEVER,

    /** A job is created and is running; anything else is refused at once. */
    JOBS,
}

/** One request the transport was sent. */
internal data class Sent(val channel: String, val correlationId: String?, val payload: JsonObject)

private fun refused(operation: String): Nothing =
    throw TransportError(TransportErrorCode.Error, "No response scripted for bus operation \"$operation\": queue one, or answer it from a step")

private fun job(operation: String): JsonElement = when (operation) {
    "job:create" -> JsonObject(mapOf("jobId" to JsonPrimitive("job-1")))
    "job:status-requested" -> JsonObject(
        mapOf(
            "jobId" to JsonPrimitive("job-1"),
            "type" to JsonPrimitive("mark"),
            "status" to JsonPrimitive("running"),
            "userId" to JsonPrimitive("did:web:example.org:users:alice"),
            "created" to JsonPrimitive("2026-10-01T00:00:00.000Z"),
        ),
    )
    else -> refused(operation)
}

/**
 * The transport a case of specs/src/client/state-units.json states, on the
 * case's clock. Its stream carries what a client's does: the replies and the
 * broadcasts, never the requests. A reply comes a turn after the request was
 * sent, `delayMs` later when the case says so, and never for `NEVER`; what was
 * queued for an operation answers before `answers` does, and is spent even
 * when its reply is lost, as a gateway answers whatever the wire then does.
 */
internal class Answering(private val answers: Answers, private val delayMs: Long?, clock: CoroutineContext) : Transport {
    private val replies = mutableMapOf<String, ArrayDeque<JsonElement?>>()
    private val router = ReplyRouter()
    private val channels = mutableMapOf<String, Broadcast<Frame>>()
    private val failing = Broadcast<SemiontError>()
    private val arriving = CoroutineScope(SupervisorJob() + clock)
    private var bus: FrameSink? = null

    /** Every request sent, in order. */
    val requestLog = mutableListOf<Sent>()

    /** Queue what the gateway answers the next request of `operation` with: a `response`, or none for a reply that carries none. */
    fun queueReply(operation: String, response: JsonElement?) {
        replies.getOrPut(operation) { ArrayDeque() }.addLast(response)
    }

    /** Deliver a frame as if the stream had carried it. */
    fun deliver(frame: Frame) {
        router.route(frame)
        synchronized(channels) { channels[frame.channel] }?.deliver(frame)
        bus?.deliver(frame)
    }

    override val baseUrl: String = "scripted://gateway"
    override val state: Watched<ConnectionState> = Watched(MutableStateFlow(ConnectionState.Open)) { it == ConnectionState.Closed }

    override suspend fun emit(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): Long? {
        val request = Frame(channel, payload, correlationId, scope)
        val operation = OPERATIONS[channel]
        if (operation == null) {
            echo(request)
            return 1
        }
        requestLog += Sent(channel, correlationId, payload)
        val queued = replies[channel]
        val response = if (!queued.isNullOrEmpty()) {
            queued.removeFirst()
        } else {
            when (answers) {
                Answers.NEVER -> null
                Answers.JOBS -> job(channel)
                Answers.REFUSES -> refused(channel)
            }
        }
        val answered = mutableMapOf<String, JsonElement>()
        // A reply that names what it answers for names what its request did, as a gateway's does.
        for (named in operation.replyNames) answered[named] = payload[named] ?: throw TransportError(TransportErrorCode.Error, "the reply to $channel names \"$named\", which this request does not state")
        if (response != null) answered["response"] = response
        val reply = Frame(operation.result.name, JsonObject(answered), correlationId)
        echo(request)
        if (answers != Answers.NEVER) {
            arriving.launch {
                delayMs?.let { delay(it) }
                deliver(reply)
            }
        }
        return 1
    }

    /** A frame this transport sent, given back to it when its stream carries the frame's channel. */
    private fun echo(sent: Frame) {
        if (isSubscribed(sent.channel)) deliver(sent)
    }

    override fun emitFuture(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): CompletableFuture<Long?> =
        throw UnsupportedOperationException("the client emits by its own future")

    override fun frames(channel: String): Events<Frame> {
        if (!isSubscribed(channel)) throw unsubscribed(channel)
        return synchronized(channels) { channels.getOrPut(channel) { Broadcast() } }.listen()
    }

    override fun isSubscribed(channel: String): Boolean = channel in BRIDGED_CHANNELS

    override fun subscribeToResource(resourceId: ResourceId): ResourceHold = ResourceHold {}

    override fun failures(): Events<SemiontError> = failing.listen()

    override fun bridgeInto(bus: FrameSink) {
        this.bus = bus
    }

    override fun trackReply(correlationId: String, replyChannels: Collection<String>): PendingReply = router.track(correlationId, replyChannels)

    override fun close() {
        arriving.cancel()
        router.close()
        failing.close()
        synchronized(channels) { channels.values.toList() }.forEach { it.close() }
    }
}
