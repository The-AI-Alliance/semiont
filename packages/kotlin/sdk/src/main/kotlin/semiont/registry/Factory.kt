package semiont.registry

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import semiont.errors.SessionError
import semiont.session.OpenedSession
import semiont.session.SessionSignals
import semiont.storage.SessionStorage
import semiont.telemetry.futureOf
import semiont.types.KnowledgeBase
import java.util.concurrent.CompletableFuture

/** What a session is built from. */
public class SessionFactoryOptions(
    /** The knowledge base the session is for. */
    public val kb: KnowledgeBase,
    /** Where its tokens are kept: the registry's own storage. */
    public val storage: SessionStorage,
    /** Where the session says it is over, for a host to show. */
    public val signals: SessionSignals,
    /** Told each failure that makes the session unusable. */
    public val onError: (SessionError) -> Unit,
)

/**
 * What builds the sessions a registry activates, and ends the credentials of
 * one. A registry is given one, and so manages sessions over any transport
 * without knowing which.
 */
public interface SessionFactory {
    /**
     * The session of a knowledge base, over a client of its own, started: the
     * registry waits for it to be ready. Closing what it gives ends the
     * session, then its client, then what it was built on. A knowledge base
     * this factory cannot reach is refused with a `SessionError`
     * (`session.construct-failed`).
     */
    public suspend fun session(options: SessionFactoryOptions): OpenedSession

    /**
     * Tell whoever issued a stored session that it has been forgotten, so its
     * refresh token is good for nothing. Best effort: the sign-out has happened
     * whether or not the issuer hears of it.
     */
    public suspend fun revoke(stored: StoredSession)

    /** `session`, for Java. */
    public fun sessionFuture(options: SessionFactoryOptions): CompletableFuture<OpenedSession> = CoroutineScope(Dispatchers.Default).futureOf { session(options) }

    /** `revoke`, for Java. */
    public fun revokeFuture(stored: StoredSession): CompletableFuture<Unit> = CoroutineScope(Dispatchers.Default).futureOf { revoke(stored) }
}

/** What a registry is made of: where everything it keeps is kept, and what builds a knowledge base's session. */
public data class SemiontBrowserConfig(public val storage: SessionStorage, public val sessionFactory: SessionFactory)

/**
 * What the credential stored for a knowledge base says, read without asking
 * anyone: a token is stored and has not expired, a token is stored and has
 * expired, or nothing is stored.
 */
public enum class KbSessionStatus(
    /** The status as every SDK spells it. */
    public val wire: String,
) {
    Authenticated("authenticated"),
    Expired("expired"),
    SignedOut("signed-out"),
}
