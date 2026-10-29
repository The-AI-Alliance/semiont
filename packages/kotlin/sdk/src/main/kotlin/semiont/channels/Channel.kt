package semiont.channels

import kotlinx.serialization.KSerializer

/** A channel of the bus: its name, and the type of the payload a frame on it carries. */
public class Channel<P> internal constructor(
    /** The channel's name, as the registry and the wire spell it. */
    public val name: String,
    internal val payload: KSerializer<P>,
) {
    override fun toString(): String = name
}
