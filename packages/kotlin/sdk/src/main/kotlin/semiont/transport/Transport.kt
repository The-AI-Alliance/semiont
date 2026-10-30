@file:OptIn(kotlinx.coroutines.ExperimentalForInheritanceCoroutinesApi::class, kotlin.ExperimentalStdlibApi::class)

package semiont.transport

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.consumeAsFlow
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.flow.transformWhile
import kotlinx.coroutines.jdk9.asPublisher
import kotlinx.serialization.json.JsonObject
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode
import semiont.errors.SemiontError
import semiont.identifiers.ResourceId
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Flow.Publisher

/**
 * What happens, one thing after another, from when it was asked for: read by
 * one collector, once. A second collection is refused. Java reads it as a
 * `java.util.concurrent.Flow.Publisher`. Closing it stops the listening:
 * nothing more is kept for it, and its reading is over.
 */
public class Events<T : Any> internal constructor(private val source: Flow<T>, private val stop: () -> Unit) : Flow<T>, AutoCloseable {
    @Volatile
    private var closed = false

    override suspend fun collect(collector: FlowCollector<T>) {
        if (closed) return
        source.takeWhile { !closed }.collect(collector)
    }

    /** The same events, for Java. */
    public fun asPublisher(): Publisher<T> = asFlow().asPublisher()

    private fun asFlow(): Flow<T> = this

    override fun close() {
        closed = true
        stop()
    }
}

/**
 * A value that changes: what it is now, and, collected, what it is and each
 * thing it becomes, ending once it has become what ends it. Java reads it as
 * a `java.util.concurrent.Flow.Publisher`.
 */
public class Watched<T : Any> internal constructor(private val state: StateFlow<T>, private val ends: (T) -> Boolean) : Flow<T> {
    /** What it is now. */
    public val value: T get() = state.value

    override suspend fun collect(collector: FlowCollector<T>): Unit =
        state.transformWhile {
            emit(it)
            !ends(it)
        }.collect(collector)

    /** The same values, for Java. */
    public fun asPublisher(): Publisher<T> = asFlow().asPublisher()

    private fun asFlow(): Flow<T> = this
}

/**
 * Everyone who listens hears each thing delivered from when they began to
 * listen, in order: each listener has a queue of its own, so a slow one delays
 * nobody and loses nothing. What is delivered before anyone has listened is
 * kept for the first listener, when `keepForFirst` says so.
 */
internal class Broadcast<T : Any>(private val keepForFirst: Boolean = false) {
    private val listeners = CopyOnWriteArrayList<Channel<T>>()
    private val early = mutableListOf<T>()

    /** How many listen now. */
    val listening: Int get() = listeners.size
    private var listened = false
    private var closed = false

    fun listen(): Events<T> {
        val queue = Channel<T>(Channel.UNLIMITED)
        synchronized(this) {
            if (closed) {
                queue.close()
            } else {
                if (!listened && keepForFirst) early.forEach { queue.trySend(it) }
                listened = true
                early.clear()
                listeners += queue
                queue.invokeOnClose { listeners -= queue }
            }
        }
        return Events(queue.consumeAsFlow()) { queue.close() }
    }

    /** Give `value` to every listener. Returns how many there were. */
    fun deliver(value: T): Int {
        synchronized(this) {
            if (closed) return 0
            if (!listened && keepForFirst) early += value
        }
        val now = listeners.toList()
        now.forEach { it.trySend(value) }
        return now.size
    }

    /** End every listener's events, and every later one's. */
    fun close() {
        val now = synchronized(this) {
            closed = true
            early.clear()
            listeners.toList()
        }
        now.forEach { it.close() }
    }
}

/** A connection's state: whether the bus can deliver (docs/protocol/TRANSPORT-HTTP.md, Connection lifecycle). */
public enum class ConnectionState(
    /** The state as every SDK spells it. */
    public val wire: String,
) {
    /** Before the transport has started its stream. */
    Initial("initial"),

    /** A connect is in flight and no stream is live. */
    Connecting("connecting"),

    /** A stream is live. It is left only when the stream drops. */
    Open("open"),

    /** The stream dropped, or a connect failed with none live. */
    Reconnecting("reconnecting"),

    /** Has been reconnecting for longer than the degraded threshold. */
    Degraded("degraded"),

    /** Not attempting: there is no credential, or the one there is was refused. */
    Unauthenticated("unauthenticated"),

    /** The transport was closed. Terminal. */
    Closed("closed"),
    ;

    internal fun mayBecome(next: ConnectionState): Boolean = next in when (this) {
        Initial -> setOf(Connecting, Unauthenticated, Closed)
        Connecting -> setOf(Open, Reconnecting, Unauthenticated, Closed)
        Open -> setOf(Reconnecting, Closed)
        Reconnecting -> setOf(Connecting, Degraded, Unauthenticated, Closed)
        Degraded -> setOf(Connecting, Unauthenticated, Closed)
        Unauthenticated -> setOf(Connecting, Closed)
        Closed -> emptySet()
    }
}

/** A W3C trace context, as the wire carries one. */
public data class TraceContext(public val traceparent: String, public val tracestate: String? = null)

/** A frame as a transport delivers it: a payload, and what is beside it, never inside it. */
public data class Frame(
    public val channel: String,
    public val payload: JsonObject,
    /** What pairs a reply with its request. */
    public val correlationId: String? = null,
    /** The resource whose scope the frame was delivered on. */
    @get:JvmExposeBoxed
    public val scope: ResourceId? = null,
    /** The trace the work done for this frame continues, when the frame was sent under one. */
    public val trace: TraceContext? = null,
)

/** Where a transport delivers every frame it receives: its client's own bus. */
public fun interface FrameSink {
    /** Take one frame, as the transport delivered it. */
    public fun deliver(frame: Frame)
}

/** One hold on a resource's scope. Let go by `close`; letting go twice is letting go once. */
public class ResourceHold internal constructor(release: () -> Unit) : AutoCloseable {
    private var release: (() -> Unit)? = release

    override fun close() {
        val letGo = synchronized(this) { release.also { release = null } }
        letGo?.invoke()
    }
}

/** A reply a request awaits. Closing it stops the wait: the transport names the reply no more, and one that comes anyway reaches nobody. */
public class PendingReply internal constructor(private val reply: CompletableDeferred<Frame?>, private val forget: () -> Unit) : AutoCloseable {
    /** The reply. Null when the transport closed before one came. */
    public suspend fun frame(): Frame? = reply.await()

    override fun close(): Unit = forget()
}

/** The refusal a transport gives for a channel it can never deliver. */
public fun unsubscribed(channel: String): BusRequestError = BusRequestError(
    BusRequestErrorCode.Unsubscribed,
    "Transport is not subscribed to $channel: a frame on it can never arrive on this connection. Add the channel to this client's channels.",
)

/**
 * The replies a transport's requests still await. A reply is handed, by its
 * correlation id, to the one request that awaits it; and the ids here are
 * what a wire transport names when it opens a stream, so a reply published
 * while the stream was down is sent again.
 */
internal class ReplyRouter {
    private class Awaited(val channels: Set<String>, val reply: CompletableDeferred<Frame?>)

    private val awaited = mutableMapOf<String, Awaited>()
    private var closed = false

    @Synchronized
    fun track(correlationId: String, replyChannels: Collection<String>): PendingReply {
        val reply = CompletableDeferred<Frame?>()
        if (closed) reply.complete(null) else awaited[correlationId] = Awaited(replyChannels.toSet(), reply)
        return PendingReply(reply) {
            synchronized(this) { if (awaited[correlationId]?.reply === reply) awaited.remove(correlationId) }
        }
    }

    @Synchronized
    fun route(frame: Frame) {
        val id = frame.correlationId ?: return
        val waiting = awaited[id] ?: return
        if (frame.channel !in waiting.channels) return
        awaited.remove(id)
        waiting.reply.complete(frame)
    }

    /** The correlation ids still awaited, in name order. */
    @Synchronized
    fun awaited(): List<String> = awaited.keys.sorted()

    @Synchronized
    fun close() {
        closed = true
        awaited.values.forEach { it.reply.complete(null) }
        awaited.clear()
    }
}

/** The bus, over whatever carries it (docs/protocol/TRANSPORT-CONTRACT.md). */
public interface Transport : AutoCloseable {
    /** What the transport speaks to: an origin over HTTP. */
    public val baseUrl: String

    /** The connection's state: what it is, and what it becomes. */
    public val state: Watched<ConnectionState>

    /**
     * Send one frame. Returns, once it has been accepted, the number of
     * subscribers it reached, or null when there is no count: an absent count
     * is never a zero. `scope` makes it a broadcast on that resource's scope.
     * Throws `TransportError` when it is refused, or never answered.
     */
    public suspend fun emit(channel: String, payload: JsonObject, scope: ResourceId? = null, correlationId: String? = null): Long?

    /** `emit`, for Java. */
    public fun emitFuture(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): CompletableFuture<Long?>

    /** The frames delivered on `channel` from now on. Throws `BusRequestError` (`bus.unsubscribed`) for a channel this transport can never deliver. */
    public fun frames(channel: String): Events<Frame>

    /** Whether the transport's stream delivers `channel` with no scope held: whether a reply published there can reach this client. */
    public fun isSubscribed(channel: String): Boolean

    /** Take one hold on a resource's scope. The scope is on the stream from its first hold to its last release. */
    public fun subscribeToResource(resourceId: ResourceId): ResourceHold

    /** The failures the transport meets from now on: everything a server refused, and every request never answered. */
    public fun failures(): Events<SemiontError>

    /** Deliver into `bus` every frame this transport delivers. The bus is its client's: a transport never makes one. */
    public fun bridgeInto(bus: FrameSink)

    /** Await the reply to `correlationId` on one of `replyChannels`. A request calls this before it emits, so its reply cannot arrive unawaited. */
    public fun trackReply(correlationId: String, replyChannels: Collection<String>): PendingReply

    /** Stop: the state becomes `closed`, every reader's events end, and every request still pending fails as closed. Closing twice is closing once. */
    override fun close()
}
