@file:OptIn(kotlin.ExperimentalStdlibApi::class, kotlinx.coroutines.ExperimentalForInheritanceCoroutinesApi::class)

package semiont.bus

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.jdk9.asPublisher
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import semiont.Timings
import semiont.channels.Channel
import semiont.channels.ScopedChannel
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.identifiers.ResourceId
import semiont.identifiers.UserId
import semiont.telemetry.futureOf
import semiont.transport.Carried
import semiont.transport.ConnectionState
import semiont.transport.Delivered
import semiont.transport.Events
import semiont.transport.Frame
import semiont.transport.FrameRefusal
import semiont.transport.Heard
import semiont.transport.ResourceHold
import semiont.transport.TraceContext
import semiont.transport.Transport
import semiont.transport.scope
import semiont.types.wireJson
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Flow.Publisher

/** The type of every event of the record. */
public val PERSISTED_EVENT_TYPES: List<String> = semiont.channels.PERSISTED

/** What the gateway stamps on a payload to say who emitted it. */
internal const val EMITTED_BY = "_userId"

/**
 * The result and failure channels of `operations`, each once: what a process
 * that awaits only those operations names as its transport's channels, so it
 * hears its replies and nothing else.
 */
public fun replyChannelsFor(vararg operations: Operation<*, *, *>): List<String> =
    operations.flatMap { listOf(it.result.name, it.failure.name) }.distinct()

/**
 * A payload as its channel types it, held to the table before it is decoded.
 * What the gateway stamps on a payload (a member whose name begins `_`) is the
 * bus's, not the payload's: one the channel's payload does not declare is left
 * out before the payload is read. Throws `TransportError` (`error`) for a
 * payload that is not that channel's, saying its first fault in every SDK's
 * words.
 */
public fun <P> decoded(channel: Channel<P>, payload: JsonObject): P = decode(channel.name, channel.payload, channel.stamps, payload)

/** `decoded`, for a channel a resource's scope carries. */
public fun <P> decoded(channel: ScopedChannel<P>, payload: JsonObject): P = decode(channel.name, channel.payload, channel.stamps, payload)

/** `payload` without what the gateway stamped on it that `stamps` does not declare. */
private fun declared(stamps: Set<String>, payload: JsonObject): JsonObject = JsonObject(payload.filterKeys { !it.startsWith("_") || it in stamps })

private fun <P> decode(channel: String, serializer: KSerializer<P>, stamps: Set<String>, payload: JsonObject): P {
    val declared = declared(stamps, payload)
    val fault = faultOf(serializer.descriptor, declared) ?: try {
        return wireJson.decodeFromJsonElement(serializer, declared)
    } catch (_: IllegalArgumentException) {
        UNDECODED
    }
    throw TransportError(TransportErrorCode.Error, notTheChannels(channel, fault))
}

private fun <P> encoded(channel: Channel<P>, payload: P): JsonObject = wireJson.encodeToJsonElement(channel.payload, payload).jsonObject

/** What is said of a payload on `channel` that has `fault`, in every SDK's words. */
private fun notTheChannels(channel: String, fault: Fault): String = "a payload on $channel is not that channel's: $fault"

/**
 * Send `payload` as the request of `operation`, and wait up to `timeoutMs`
 * for its reply: the payload of the reply on the operation's result channel.
 * For what relays requests it does not read; `Bus.request` types them.
 * Throws `BusRequestError` when it is answered with a failure, when no reply
 * comes in time, when the transport is closed, and when its stream does not
 * carry the operation's replies; and `TransportError` when the emit itself is
 * refused.
 */
public suspend fun request(transport: Transport, operation: Operation<*, *, *>, payload: JsonObject, timeoutMs: Long = Timings.BUS_REQUEST_TIMEOUT_MS): JsonObject =
    resultOf(transport, operation, payload, timeoutMs).payload

/** `request`, for Java. */
public fun requestFuture(transport: Transport, operation: Operation<*, *, *>, payload: JsonObject, timeoutMs: Long): CompletableFuture<JsonObject> =
    CoroutineScope(Dispatchers.Default).futureOf { request(transport, operation, payload, timeoutMs) }

/**
 * A request of the bus, as far as the frame that answers it on its
 * operation's result channel; a failure is the request's error. It is not
 * sent before its reply can arrive: it waits, inside its own deadline, for the
 * stream to be open. Its reply is tracked before it is emitted, and the emit
 * is not cut short by the deadline: a request half sent is one nobody can
 * account for. Cancelled, it reports nothing more, and a reply that comes
 * anyway settles nothing.
 */
internal suspend fun resultOf(transport: Transport, operation: Operation<*, *, *>, payload: JsonObject, timeoutMs: Long): Frame {
    val asked = operation.request.name
    val result = operation.result.name
    val failure = operation.failure.name
    for (channel in listOf(result, failure)) {
        if (!transport.isSubscribed(channel)) {
            throw BusRequestError(
                BusRequestErrorCode.Unsubscribed,
                "Transport is not subscribed to reply channel $channel: a reply to $asked can never arrive. Add this operation's reply channels to the transport's channels.",
            )
        }
    }
    val deadline = System.nanoTime() / 1_000_000 + timeoutMs
    fun left(): Long = maxOf(0, deadline - System.nanoTime() / 1_000_000)
    fun timedOut() = BusRequestError(BusRequestErrorCode.Timeout, "Bus request timed out after ${timeoutMs}ms on $result")

    val state = withTimeoutOrNull(left()) { transport.state.first { it == ConnectionState.Open || it == ConnectionState.Closed } } ?: throw timedOut()
    if (state != ConnectionState.Open) throw BusRequestError(BusRequestErrorCode.Closed, "Bus closed before emit on $asked")

    val correlationId = UUID.randomUUID().toString()
    transport.trackReply(correlationId, listOf(result, failure)).use { pending ->
        transport.emit(asked, payload, correlationId = correlationId)
        val came = withTimeoutOrNull(left()) { listOf(pending.frame()) } ?: throw timedOut()
        val reply = came.single() ?: throw BusRequestError(BusRequestErrorCode.Closed, "Bus closed before a reply on $result")
        if (reply.channel == result) return reply
        throw BusRequestError.answered(reply.payload)
    }
}

private fun <P> delivered(frame: Frame, payload: P): Delivered<P> =
    Delivered(
        payload = payload,
        correlationId = frame.correlationId,
        scope = frame.scope,
        userId = ((frame.payload[EMITTED_BY] as? JsonPrimitive)?.takeIf { it.isString })?.content?.let { UserId.parse(it) },
        trace = frame.trace,
    )

/** The way from a frame to the member of its payload whose way from the payload is `member`. */
private fun inPayload(member: String): String = if (member.isEmpty()) "payload" else "payload.$member"

/**
 * What a typed read of `channel` gives for `carried`: a frame, its payload
 * decoded, or the refusal of one whose payload is not the channel's; and a
 * frame the transport refused, its refusal as it came.
 */
internal fun <P> heard(channel: Channel<P>, carried: Carried): Heard<P> = heard(channel.payload, channel.stamps, carried)

private fun <P> heard(payload: KSerializer<P>, stamps: Set<String>, carried: Carried): Heard<P> {
    val frame = when (carried) {
        is Frame -> carried
        is FrameRefusal -> return carried
    }
    val declared = declared(stamps, frame.payload)
    val fault = faultOf(payload.descriptor, declared) ?: try {
        return delivered(frame, wireJson.decodeFromJsonElement(payload, declared))
    } catch (_: IllegalArgumentException) {
        UNDECODED
    }
    return FrameRefusal(frame.channel, inPayload(fault.member), fault.reason, frame.payload, null, frame.scope)
}

/**
 * One channel's frames from now on, each with its payload decoded: read by
 * one collector, once. A frame refused, by the transport or because its
 * payload is not the channel's, is told the reader in its place, as a
 * `FrameRefusal`, and the frames after it follow. Read for a resource, it
 * gives that resource's frames and no other's, and holds that resource's
 * scope until it is closed or its reading ends. Java reads it as a
 * `java.util.concurrent.Flow.Publisher`.
 */
public class Typed<P> internal constructor(
    private val payload: KSerializer<P>,
    private val stamps: Set<String>,
    private val frames: Events<Carried>,
    private val resource: ResourceId?,
    private val hold: ResourceHold?,
) : Flow<Heard<P>>, AutoCloseable {
    override suspend fun collect(collector: FlowCollector<Heard<P>>) {
        try {
            frames.collect { carried ->
                // A stream carries every scope it holds on the one channel, and another reader may hold another resource's.
                if (resource != null && carried.scope != resource) return@collect
                collector.emit(heard(payload, stamps, carried))
            }
        } finally {
            close()
        }
    }

    /** The same frames, for Java. */
    public fun asPublisher(): Publisher<Heard<P>> = asFlow().asPublisher()

    private fun asFlow(): Flow<Heard<P>> = this

    /** Stop listening, and let go of the scope it held. */
    override fun close() {
        frames.close()
        hold?.close()
    }
}

/**
 * The bus over a transport, typed by channel: a channel is one of `Channels`'
 * constants, and a payload is that channel's own, so the compiler refuses a
 * wrong payload for a channel, gives a frame its payload's type, and gives a
 * request its operation's reply. A client hands it out as `wire`.
 *
 * A caller abandons a request by cancelling the coroutine that awaits it, or
 * from Java the future: what was sent stays sent, the reply stops being
 * tracked, and one that comes anyway reaches nobody. Cancelled while it waits
 * for the stream, it sends nothing.
 */
public class Bus(private val transport: Transport) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Send one frame on `channel`: how many subscribers the gateway reached, or null when it kept no count. */
    public suspend fun <P> emit(channel: Channel<P>, payload: P, scope: ResourceId? = null, correlationId: String? = null): Long? =
        transport.emit(channel.name, encoded(channel, payload), scope, correlationId)

    /** `emit`, for Java. */
    @JvmExposeBoxed
    public fun <P> emitFuture(channel: Channel<P>, payload: P, scope: ResourceId?, correlationId: String?): CompletableFuture<Long?> =
        this.scope.futureOf { emit(channel, payload, scope, correlationId) }

    /** The frames delivered on `channel` from now on. Throws `BusRequestError` (`bus.unsubscribed`) for a channel this transport can never deliver. */
    public fun <P> frames(channel: Channel<P>): Typed<P> =
        Typed(channel.payload, channel.stamps, transport.frames(channel.name), null, null)

    /** The frames delivered on `channel` for `resource` from now on: the read holds that resource's scope until it is closed or its reading ends. */
    @JvmExposeBoxed
    public fun <P> frames(channel: ScopedChannel<P>, resource: ResourceId): Typed<P> {
        val frames = transport.frames(channel.name)
        return Typed(channel.payload, channel.stamps, frames, resource, transport.subscribeToResource(resource))
    }

    /**
     * Send `payload` as the request of `operation`, and wait up to
     * `timeoutMs` for its result. Throws as the free `request` does, and
     * `TransportError` when the result that came is not the operation's.
     */
    public suspend fun <Q, R, F> request(operation: Operation<Q, R, F>, payload: Q, timeoutMs: Long = Timings.BUS_REQUEST_TIMEOUT_MS): R =
        decoded(operation.result, resultOf(transport, operation, encoded(operation.request, payload), timeoutMs).payload)

    /** `request`, for Java. */
    public fun <Q, R, F> requestFuture(operation: Operation<Q, R, F>, payload: Q, timeoutMs: Long): CompletableFuture<R> =
        scope.futureOf { request(operation, payload, timeoutMs) }
}
