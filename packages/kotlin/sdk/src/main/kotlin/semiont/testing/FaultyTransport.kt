@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.testing

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import semiont.bus.EMITTED_BY
import semiont.bus.OPERATIONS
import semiont.channels.TRACE_FIELD
import semiont.errors.SemiontError
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.http.FrameHub
import semiont.identifiers.ResourceId
import semiont.telemetry.futureOf
import semiont.transport.Broadcast
import semiont.transport.ConnectionState
import semiont.transport.Events
import semiont.transport.Frame
import semiont.transport.FrameSink
import semiont.transport.PendingReply
import semiont.transport.ReplyRouter
import semiont.transport.ResourceHold
import semiont.transport.Transport
import semiont.transport.Variable
import semiont.transport.Watched
import semiont.transport.unsubscribed
import java.util.concurrent.CompletableFuture
import kotlin.coroutines.CoroutineContext

/** What the wire does to one request. */
public sealed interface FaultAction {
    /** The behaviour, as every SDK spells it. */
    public val kind: String
}

/** The request's reply is delivered. */
public data object Deliver : FaultAction {
    override val kind: String get() = "deliver"
}

/** The request's reply is lost. */
public data object DropReply : FaultAction {
    override val kind: String get() = "drop-reply"
}

/** The request's reply is delivered `ms` milliseconds after it was sent. */
public data class Delay(public val ms: Long) : FaultAction {
    override val kind: String get() = "delay"
}

/** The request's reply is delivered twice. */
public data object DuplicateReply : FaultAction {
    override val kind: String get() = "duplicate-reply"
}

/** The emit itself is refused: the request never reaches the gateway. */
public data object RejectEmit : FaultAction {
    override val kind: String get() = "reject-emit"
}

/**
 * What the gateway answers a request with, given its operation and its
 * payload: its `response`, or none for a reply that carries none. Throwing
 * refuses the request.
 */
public fun interface Respond {
    public fun respond(operation: String, payload: JsonObject): JsonElement?
}

/** The failure the gateway answers a request with, when it answers it with one: the payload of the operation's failure channel. */
public fun interface Refuse {
    public fun refuse(operation: String, payload: JsonObject): JsonObject?
}

/** What answers a request nothing was scripted for: a refusal that names the operation, never a response made up. */
public val REFUSE_UNSCRIPTED: Respond = Respond { operation, _ ->
    throw TransportError(
        TransportErrorCode.Error,
        "No response scripted for bus operation \"$operation\". Script one with queueReply(\"$operation\", …) or build the transport with a Respond that answers it.",
    )
}

/** A response queued for an operation: none, for a reply that carries none. */
private class Queued(val response: JsonElement?)

/** One request the transport was sent. */
public data class RequestLogEntry(
    public val channel: String,
    /** What the schedule did to it. */
    public val action: FaultAction,
    public val correlationId: String?,
    /** The request's identity across retries: two entries with the same key are one logical request, sent again. */
    public val retryKey: String,
    /** The payload as it was sent. */
    public val payload: JsonObject,
)

/** A request's identity across retries: its channel and its payload, less what the gateway stamps on it, its members in name order. */
public fun retryKeyOf(channel: String, payload: JsonObject): String =
    "$channel ${JsonObject(payload.filterKeys { it != TRACE_FIELD && it != EMITTED_BY }.toSortedMap())}"

/**
 * A scriptable `Transport` with no wire, for tests. Two things are scripted,
 * and they are different things. The wire, by a schedule of faults applied
 * one to each request in turn (the i-th meets `schedule[i % size]`, every
 * reply delivered when it is empty): deliver its reply, drop it, delay it,
 * deliver it twice, or refuse the emit. And the gateway, by the responses
 * queued for each operation, then `respond`, asked of every request nothing
 * queued answers, refusing by name unless told otherwise. A dropped reply
 * still spends its queued response: the gateway answered and the wire ate it.
 * `refuseWhen` answers a request with a failure, asked before anything else.
 *
 * A reply that names what it answers for beside its response names what its
 * request did, as a gateway's does. A frame sent on a channel the stream
 * names (`channels`, every channel when none are given) comes back to it, as
 * a gateway gives a frame to every client whose stream names its channel.
 */
public class FaultyTransport internal constructor(
    private val schedule: List<FaultAction>,
    private val respond: Respond,
    private val channels: Collection<String>?,
    context: CoroutineContext,
) : Transport {
    /** A transport whose replies arrive on the default dispatcher. */
    @JvmOverloads
    public constructor(
        schedule: List<FaultAction> = emptyList(),
        respond: Respond = REFUSE_UNSCRIPTED,
        channels: Collection<String>? = null,
    ) : this(schedule, respond, channels, Dispatchers.Default)

    private val replies = mutableMapOf<String, ArrayDeque<Queued>>()
    private val log = mutableListOf<RequestLogEntry>()
    private val sent = mutableListOf<Frame>()
    private val held = mutableMapOf<ResourceId, Int>()
    private val hub = FrameHub()
    private val router = ReplyRouter()
    private val connection = Variable(ConnectionState.Open)
    private val failing = Broadcast<SemiontError>(keepForFirst = true)
    private val arriving = CoroutineScope(SupervisorJob() + context)
    private var refusing: Refuse? = null

    @Volatile
    private var closed = false

    /**
     * Queue what the gateway answers the next requests of `operation` with,
     * one each, before `respond` is asked: each a `response`, or none for a
     * reply that carries none.
     */
    public fun queueReply(operation: String, responses: List<JsonElement?>): Unit = synchronized(this) {
        replies.getOrPut(operation) { ArrayDeque() }.addAll(responses.map(::Queued))
    }

    /** Have the gateway answer with a failure every request `refuse` gives one for, such as `{"code": "not-found", "message": "…"}`. */
    public fun refuseWhen(refuse: Refuse): Unit = synchronized(this) { refusing = refuse }

    /** Report a failure on the failure stream, as a transport does of a request the gateway refused. */
    public fun fail(error: SemiontError) {
        failing.deliver(error)
    }

    /** Change the connection's state, as a wire would. */
    public fun setState(state: ConnectionState): Unit = connection.set(state)

    /** Deliver a frame as if the stream had carried it. */
    public fun deliver(frame: Frame) {
        router.route(frame)
        hub.deliver(frame)
    }

    /** Every request sent, in order. */
    public val requestLog: List<RequestLogEntry> get() = synchronized(this) { log.toList() }

    /** Every frame emitted through it, in order: the requests, and what was only sent. */
    public val emitted: List<Frame> get() = synchronized(this) { sent.toList() }

    /** How many holds there are on a resource's scope. */
    @JvmExposeBoxed
    public fun holds(resourceId: ResourceId): Int = synchronized(this) { held[resourceId] ?: 0 }

    /** The resources whose scope is held, in name order. */
    public val scopes: List<ResourceId> get() = synchronized(this) { held.keys.sortedBy { it.value } }

    /** The correlation ids of the replies still awaited. */
    public val pendingReplies: List<String> get() = router.awaited()

    override val baseUrl: String = "faulty://simulator"

    override val state: Watched<ConnectionState> = connection.reading()

    override suspend fun emit(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): Long? {
        if (closed) return null
        val request = Frame(channel, payload, correlationId, scope)
        val operation = OPERATIONS[channel]
        val (action, refuse) = synchronized(this) {
            sent += request
            if (operation == null) return@synchronized null to null
            val action = if (schedule.isEmpty()) Deliver else schedule[log.size % schedule.size]
            log += RequestLogEntry(channel, action, correlationId, retryKeyOf(channel, payload), payload)
            action to refusing
        }
        if (operation == null || action == null) {
            echo(request)
            return 1
        }
        if (action == RejectEmit) throw TransportError(TransportErrorCode.Error, "FaultyTransport: emit rejected by schedule on $channel")
        // The gateway answers once per request that reaches it, whatever the wire then does to the answer.
        val refused = refuse?.refuse(channel, payload)
        val reply = if (refused != null) {
            Frame(operation.failure.name, refused, correlationId)
        } else {
            val queued = synchronized(this) { replies[channel]?.removeFirstOrNull() }
            val response = if (queued != null) queued.response else respond.respond(channel, payload)
            val answered = mutableMapOf<String, JsonElement>()
            // A reply that names what it answers for names what its request did, as a gateway's does.
            for (named in operation.replyNames) {
                answered[named] = payload[named] ?: throw TransportError(TransportErrorCode.Error, "FaultyTransport: the reply to $channel names \"$named\", which this request does not state")
            }
            if (response != null) answered["response"] = response
            Frame(operation.result.name, JsonObject(answered), correlationId)
        }
        echo(request)
        // The reply comes after the emit has been accepted, as a wire's does. One on its way when the transport closes is dropped.
        when (action) {
            Deliver -> arriving.launch { deliver(reply) }
            DuplicateReply -> arriving.launch { repeat(2) { deliver(reply) } }
            is Delay -> arriving.launch {
                delay(action.ms)
                deliver(reply)
            }
            DropReply, RejectEmit -> Unit
        }
        return 1
    }

    /** A frame this transport sent, given back to it when its stream names the frame's channel. */
    private fun echo(sent: Frame) {
        if (isSubscribed(sent.channel)) deliver(sent)
    }

    @JvmExposeBoxed
    override fun emitFuture(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): CompletableFuture<Long?> =
        arriving.futureOf { emit(channel, payload, scope, correlationId) }

    override fun frames(channel: String): Events<Frame> {
        if (!isSubscribed(channel)) throw unsubscribed(channel)
        return hub.frames(channel)
    }

    override fun isSubscribed(channel: String): Boolean = channels == null || channel in channels

    /** Nothing here is delivered by scope, so a hold changes only the count of them (`holds`). */
    @JvmExposeBoxed
    override fun subscribeToResource(resourceId: ResourceId): ResourceHold {
        synchronized(this) { held[resourceId] = (held[resourceId] ?: 0) + 1 }
        return ResourceHold {
            synchronized(this) {
                val remaining = (held[resourceId] ?: 1) - 1
                if (remaining > 0) held[resourceId] = remaining else held.remove(resourceId)
            }
        }
    }

    override fun failures(): Events<SemiontError> = failing.listen()

    override fun bridgeInto(bus: FrameSink): Unit = hub.bridge(bus)

    override fun trackReply(correlationId: String, replyChannels: Collection<String>): PendingReply = router.track(correlationId, replyChannels)

    override fun close() {
        closed = true
        connection.set(ConnectionState.Closed)
        connection.end()
        arriving.cancel()
        hub.close()
        router.close()
        failing.close()
    }
}
