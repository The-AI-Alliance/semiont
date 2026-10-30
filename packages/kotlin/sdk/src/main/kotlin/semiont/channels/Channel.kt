package semiont.channels

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonIgnoreUnknownKeys

/**
 * A channel of no resource's scope: its name, and the type of the payload a
 * frame on it carries. It is delivered to every client whose stream names it.
 * A channel is its own payload's and no other's: a `Channel<A>` is not a
 * `Channel<B>`, so what takes a channel and a payload is refused another
 * channel's payload.
 */
public class Channel<P> internal constructor(
    /** The channel's name, as the registry and the wire spell it. */
    public val name: String,
    internal val payload: KSerializer<P>,
    /** The members beginning `_` that its payload declares: what the gateway stamps on a frame that is the payload's own. */
    internal val stamps: Set<String>,
) {
    override fun toString(): String = name
}

/**
 * A channel a resource's scope carries: an event of the record, delivered to
 * the clients that hold its resource's scope. It is not a `Channel`, so a
 * read of one names its resource, and a read that names none does not
 * compile: nothing would ever be delivered to it.
 */
public class ScopedChannel<P> internal constructor(
    /** The channel's name, as the registry and the wire spell it. */
    public val name: String,
    internal val payload: KSerializer<P>,
    /** The members beginning `_` that its payload declares. */
    internal val stamps: Set<String>,
) {
    override fun toString(): String = name
}

/** The payload of a reply that wraps what it answers with: `{ response }`. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonIgnoreUnknownKeys
public data class Response<T>(
    @SerialName("response")
    public val response: T,
)

/** The payload of a channel that carries none: the empty object. */
@Serializable
public data object Empty
