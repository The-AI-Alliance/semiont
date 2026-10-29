@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.bus

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.future.future
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import semiont.Timings
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode
import semiont.identifiers.ResourceId
import semiont.transport.ConnectionState
import semiont.transport.Frame
import semiont.transport.Transport
import java.util.UUID
import java.util.concurrent.CompletableFuture

/** The type of every event of the record. */
public val PERSISTED_EVENT_TYPES: List<String> = semiont.channels.PERSISTED

/**
 * A request of the bus, as far as the frame that answers it on its
 * operation's result channel; a failure is the request's error. It is not
 * sent before its reply can arrive: it waits, inside its own deadline, for the
 * stream to be open. Its reply is tracked before it is emitted, and the emit
 * is not cut short by the deadline: a request half sent is one nobody can
 * account for. Cancelled, it reports nothing more, and a reply that comes
 * anyway settles nothing.
 */
internal suspend fun resultOf(transport: Transport, operation: OperationChannels, payload: JsonObject, timeoutMs: Long): Frame {
    for (channel in listOf(operation.result, operation.failure)) {
        if (!transport.isSubscribed(channel)) {
            throw BusRequestError(
                BusRequestErrorCode.Unsubscribed,
                "Transport is not subscribed to reply channel $channel: a reply to ${operation.request} can never arrive. Add this operation's reply channels to the transport's channels.",
            )
        }
    }
    val deadline = System.nanoTime() / 1_000_000 + timeoutMs
    fun left(): Long = maxOf(0, deadline - System.nanoTime() / 1_000_000)
    fun timedOut() = BusRequestError(BusRequestErrorCode.Timeout, "Bus request timed out after ${timeoutMs}ms on ${operation.result}")

    val state = withTimeoutOrNull(left()) { transport.state.first { it == ConnectionState.Open || it == ConnectionState.Closed } } ?: throw timedOut()
    if (state != ConnectionState.Open) throw BusRequestError(BusRequestErrorCode.Closed, "Bus closed before emit on ${operation.request}")

    val correlationId = UUID.randomUUID().toString()
    transport.trackReply(correlationId, listOf(operation.result, operation.failure)).use { pending ->
        transport.emit(operation.request, payload, correlationId = correlationId)
        val came = withTimeoutOrNull(left()) { listOf(pending.frame()) } ?: throw timedOut()
        val reply = came.single() ?: throw BusRequestError(BusRequestErrorCode.Closed, "Bus closed before a reply on ${operation.result}")
        if (reply.channel == operation.result) return reply
        throw BusRequestError.answered(reply.payload)
    }
}

/** The typed bus over a client's transport, which a client hands out as `wire`. */
public class Bus(private val transport: Transport) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Send one frame on a channel named at run time: the subscribers it reached, or null when there is no count. */
    public suspend fun emitOn(channel: String, payload: JsonObject, scope: ResourceId? = null, correlationId: String? = null): Long? =
        transport.emit(channel, payload, scope, correlationId)

    /** `emitOn`, for Java. */
    @JvmExposeBoxed
    public fun emitOnFuture(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): CompletableFuture<Long?> =
        this.scope.future { emitOn(channel, payload, scope, correlationId) }

    /**
     * Send `payload` as the request of the operation named at run time, and
     * wait up to `timeoutMs` for its reply: the reply's `response`, or null
     * when it carries none. Throws `BusRequestError` when it is answered with a
     * failure, when no reply comes in time, when the transport is closed, and
     * when its stream does not carry the operation's replies; and
     * `TransportError` when the emit itself is refused.
     */
    public suspend fun requestOf(operation: String, payload: JsonObject, timeoutMs: Long = Timings.BUS_REQUEST_TIMEOUT_MS): JsonElement? {
        val channels = OPERATIONS[operation] ?: throw IllegalArgumentException("$operation is not an operation of the registry")
        return resultOf(transport, channels, payload, timeoutMs).payload["response"]
    }

    /** `requestOf`, for Java. */
    public fun requestOfFuture(operation: String, payload: JsonObject, timeoutMs: Long): CompletableFuture<JsonElement?> =
        scope.future { requestOf(operation, payload, timeoutMs) }
}
