package semiont.bus

import semiont.channels.Channel

/** A request of the bus, and the two channels it is answered on. Its types say what is sent and what each reply carries. */
public class Operation<Q, R, F> internal constructor(
    public val request: Channel<Q>,
    public val result: Channel<R>,
    public val failure: Channel<F>,
    /**
     * What the reply states beside its `response`, by the names the wire
     * gives them: each a property of the request, which a gateway states
     * again in its reply. Nothing, for most operations.
     */
    public val replyNames: List<String>,
) {
    override fun toString(): String = request.name
}
