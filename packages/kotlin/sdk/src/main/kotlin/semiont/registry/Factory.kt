package semiont.registry

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import semiont.session.OpenedSession
import semiont.session.SessionSignals
import semiont.storage.SessionStorage
import semiont.telemetry.futureOf
import semiont.types.KnowledgeBase
import java.util.concurrent.CompletableFuture
import kotlin.coroutines.CoroutineContext
import kotlin.random.Random
import kotlin.time.TimeSource

/** What a session is built from. */
public class SessionFactoryOptions(
    /** The knowledge base the session is for. */
    public val kb: KnowledgeBase,
    /** Where its tokens are kept: the registry's own storage. */
    public val storage: SessionStorage,
    /** Where the session says it is over, for a host to show. */
    public val signals: SessionSignals,
)

/**
 * What builds the sessions a registry activates, and ends the credentials of
 * one. A registry is given one, and so manages sessions over any transport
 * without knowing which. It reads none of a session's errors: the registry is
 * their one reader, from the first thing the session said.
 */
public interface SessionFactory {
    /**
     * The session of a knowledge base, over a client of its own, started: the
     * registry waits for it to be ready. Closing what it gives closes its
     * client, then ends the session, then closes what it was built on. A knowledge base
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

    /** `session`, for Java: run where `session` runs it, a factory that keeps a context running it there. */
    public fun sessionFuture(options: SessionFactoryOptions): CompletableFuture<OpenedSession> = CoroutineScope(Dispatchers.Unconfined).futureOf { session(options) }

    /** `revoke`, for Java: run where `revoke` runs it, a factory that keeps a context running it there. */
    public fun revokeFuture(stored: StoredSession): CompletableFuture<Unit> = CoroutineScope(Dispatchers.Unconfined).futureOf { revoke(stored) }
}

/**
 * What a registry is made of: where everything it keeps is kept, what builds
 * a knowledge base's session, where its work runs (`context`), the time that
 * work keeps (`clock`), and the random source its jitter draws from: what a
 * sign-in it completes keeps.
 */
public data class SemiontBrowserConfig @JvmOverloads constructor(
    public val storage: SessionStorage,
    public val sessionFactory: SessionFactory,
    public val context: CoroutineContext = Dispatchers.Default,
    public val clock: TimeSource = TimeSource.Monotonic,
    public val random: Random = Random.Default,
)

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
