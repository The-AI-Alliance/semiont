@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.bus

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import semiont.channels.Channel
import semiont.identifiers.ResourceId
import semiont.transport.Broadcast
import semiont.transport.Events
import semiont.transport.Frame
import semiont.transport.FrameSink
import semiont.types.wireJson

/**
 * A client's own bus: frames published and read inside one process. A client
 * makes one and hands it to its transport (`bridgeInto`), which delivers into
 * it every frame it receives; what the client's own parts say to each other
 * goes through it too, and never reaches the wire.
 *
 * A frame is published to everyone or into one resource's scope, and a reader
 * sees one or the other. A reader of one channel is given its frames in the
 * order they were published; two readers give no order between them, so one
 * that needs what was said on several channels in the order it was said reads
 * them as one (`framesAmong`). By type (`publish`, `frames`) the channel is one
 * of `Channels`' constants; by name (`emit`, `framesOn`) it is its name and a
 * payload a JSON object.
 */
public class EventBus : FrameSink {
    private val views = mutableMapOf<Pair<String, ResourceId?>, Broadcast<Frame>>()
    private val among = mutableListOf<Pair<Set<String>, Broadcast<Frame>>>()
    private var destroyed = false

    /** Whether the bus has ended. */
    public val isDestroyed: Boolean get() = synchronized(this) { destroyed }

    /** Publish a frame as it is: to everyone, or into the scope it names. A destroyed bus has no reader to give it to. */
    override fun deliver(frame: Frame) {
        val (readers, view) = synchronized(this) {
            val readers = if (frame.scope == null) among.filter { frame.channel in it.first }.map { it.second } else emptyList()
            readers to views[frame.channel to frame.scope]
        }
        readers.forEach { it.deliver(frame) }
        view?.deliver(frame)
    }

    /** Publish one frame on the channel named `channel`: to everyone, or into `scope`. */
    @JvmExposeBoxed
    public fun emit(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): Unit =
        deliver(Frame(channel, payload, correlationId, scope))

    /** Publish one frame of `channel`: to everyone, or into `scope`. */
    @JvmExposeBoxed
    public fun <P> publish(channel: Channel<P>, payload: P, scope: ResourceId?, correlationId: String?): Unit =
        emit(channel.name, wireJson.encodeToJsonElement(channel.payload, payload).jsonObject, scope, correlationId)

    /** The frames published on the channel named `channel` from now on: to everyone, or into `scope`. Of a destroyed bus, none. */
    @JvmExposeBoxed
    public fun framesOn(channel: String, scope: ResourceId?): Events<Frame> {
        val view = synchronized(this) {
            views[channel to scope] ?: Broadcast<Frame>().also { if (destroyed) it.close() else views[channel to scope] = it }
        }
        return view.listen()
    }

    /** The frames published on `channel` from now on, each with its payload decoded: to everyone, or into `scope`. */
    @JvmExposeBoxed
    public fun <P> frames(channel: Channel<P>, scope: ResourceId?): Typed<P> =
        Typed(channel.name, channel.payload, channel.stamps, framesOn(channel.name, scope), null, null)

    /** The frames published to everyone on any of `channels` from now on, in the order they were published. */
    public fun framesAmong(channels: Collection<String>): Events<Frame> {
        val readers = Broadcast<Frame>()
        synchronized(this) {
            if (destroyed) {
                readers.close()
            } else {
                // A view nobody reads any more is let go here, where the next one is made.
                among.removeAll { it.second.listening == 0 }
                among += channels.toSet() to readers
            }
        }
        return readers.listen()
    }

    /** End every reader's frames, and every later reader's. Destroying twice is destroying once. */
    public fun destroy() {
        val ended = synchronized(this) {
            destroyed = true
            (views.values + among.map { it.second }).also {
                views.clear()
                among.clear()
            }
        }
        ended.forEach { it.close() }
    }
}
