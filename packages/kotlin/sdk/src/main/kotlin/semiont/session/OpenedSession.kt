package semiont.session

import semiont.SemiontClient

/**
 * A session with what it was opened over: closing it ends the session, then
 * its client, then what the session was built on, its transport and what
 * renews its token. What a factory of sessions gives a registry.
 */
public class OpenedSession internal constructor(public val session: SemiontSession, private val built: AutoCloseable) : AutoCloseable {
    /** The session's client. */
    public val client: SemiontClient get() = session.client

    override fun close() {
        session.close()
        session.client.close()
        built.close()
    }
}
