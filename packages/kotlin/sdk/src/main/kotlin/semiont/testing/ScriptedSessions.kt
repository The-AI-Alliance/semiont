package semiont.testing

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import semiont.errors.SessionError
import semiont.errors.SessionErrorCode
import semiont.errors.SignInError
import semiont.errors.SignInErrorCode
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.registry.SessionFactory
import semiont.registry.SessionFactoryOptions
import semiont.registry.StoredSession
import semiont.registry.keptIn
import semiont.session.OpenedSession
import semiont.session.SemiontSession
import semiont.types.KbTarget
import semiont.types.UserResponse

/** What a knowledge base's gateway answers a request with, given the knowledge base's id, the operation and the payload: the response, none for a reply that carries none, or a refusal thrown. */
public fun interface Answer {
    public fun answer(kbId: String, operation: String, payload: JsonObject): JsonElement?
}

/** The failure a knowledge base's gateway answers a request with, on its operation's failure channel; none to answer as usual. */
public fun interface Refusal {
    public fun refuse(kbId: String, operation: String, payload: JsonObject): JsonObject?
}

/** What answers a request of a knowledge base nothing was scripted for: a refusal naming both, never a response made up. */
public val REFUSE_UNSCRIPTED_KB: Answer = Answer { kbId, operation, _ ->
    throw TransportError(TransportErrorCode.Error, "No response scripted for '$operation' of knowledge base '$kbId'. Build the factory with an answer.")
}

/** What a renewal gives: a token, none for a session with nothing to renew with, or the failure it throws. */
private sealed interface Renewal {
    class Token(val token: String?) : Renewal

    class Failure(val error: SignInError) : Renewal
}

/**
 * A `SessionFactory` for tests of a registry (`semiont.registry.SemiontBrowser`)
 * and of what is built on one. Each session it builds is a real
 * `SemiontSession` over a `FaultyTransport` of its own, and the factory keeps
 * every transport it built, by knowledge base. A test scripts three things:
 * what each knowledge base's gateway answers (`answer`, and `refuseWhen`),
 * who the gateway says a token is (`saysWho`), and what a renewal gives
 * (`queueRenewals`, `failRenewal`). Each refuses by name until it is
 * scripted: an unscripted request names its operation and its knowledge base,
 * an unscripted renewal is a renewal that failed, and a gateway nobody
 * scripted a user for cannot say who a token is.
 */
public class ScriptedSessions @JvmOverloads constructor(private val answer: Answer = REFUSE_UNSCRIPTED_KB) : SessionFactory {
    private val renewals = ArrayDeque<Renewal>()
    private val built = mutableListOf<Pair<String, FaultyTransport>>()
    private val revokedSessions = mutableListOf<StoredSession>()

    @Volatile
    private var refusing: Refusal? = null

    @Volatile
    private var refusesToBuild: String? = null

    @Volatile
    private var user: UserResponse? = null

    @Volatile
    private var answersAfterMs = 0L

    @Volatile
    private var renewedCount = 0

    /** Have a gateway answer with a failure every request `refuse` gives one for, before it is asked for an answer. Sessions already built refuse so too. */
    public fun refuseWhen(refuse: Refusal) {
        refusing = refuse
    }

    /** Refuse to build any session, saying why; none builds again. */
    public fun refuseToBuild(why: String?) {
        refusesToBuild = why
    }

    /** Who the gateway says a token is, of every session built from now. */
    public fun saysWho(user: UserResponse) {
        this.user = user
    }

    /** How long the gateway takes to say who a token is, of every session built from now. */
    public fun answersAfter(ms: Long) {
        answersAfterMs = ms
    }

    /** What the next renewals give, one each, in order: a token, or none for a session that has nothing to renew with. */
    public fun queueRenewals(vararg tokens: String?): Unit = synchronized(renewals) { tokens.forEach { renewals.addLast(Renewal.Token(it)) } }

    /** Have the next renewal, after those queued, fail with `error`. */
    public fun failRenewal(error: SignInError): Unit = synchronized(renewals) { renewals.addLast(Renewal.Failure(error)) }

    /** How many renewals were asked for. */
    public val renewed: Int get() = renewedCount

    /** The transports of the sessions built for a knowledge base, in the order they were built. */
    public fun transports(kbId: String): List<FaultyTransport> = synchronized(built) { built.filter { it.first == kbId }.map { it.second } }

    /** Every stored session the factory was told to revoke, in order. */
    public val revoked: List<StoredSession> get() = synchronized(revokedSessions) { revokedSessions.toList() }

    override suspend fun session(options: SessionFactoryOptions): OpenedSession {
        val kbId = options.kb.id
        refusesToBuild?.let { throw SessionError(SessionErrorCode.ConstructFailed, it, kbId) }
        val transport = FaultyTransport(respond = { operation, payload -> answer.answer(kbId, operation, payload) })
        transport.refuseWhen { operation, payload -> refusing?.refuse(kbId, operation, payload) }
        synchronized(built) { built += kbId to transport }
        val client = TestClient(transport).client
        val saidWho = user
        val wait = answersAfterMs
        val session = SemiontSession(
            KbTarget(kbId, options.kb.label, options.kb.endpoint),
            client,
            MutableStateFlow(null),
            keptIn(options.storage, kbId),
            {
                renewedCount += 1
                val renewal = synchronized(renewals) {
                    renewals.removeFirstOrNull()
                        ?: throw SignInError(SignInErrorCode.Exchange, "ScriptedSessions: not scripted: a renewal of '$kbId'. Script one with queueRenewals.")
                }
                when (renewal) {
                    is Renewal.Token -> renewal.token
                    is Renewal.Failure -> throw renewal.error
                }
            },
            { _: String ->
                delay(wait)
                saidWho ?: throw TransportError(TransportErrorCode.Error, "ScriptedSessions: not scripted: who a token of '$kbId' is. Script it with saysWho.")
            },
            options.signals::notifySessionEnded,
            options.onError,
        )
        session.start()
        return OpenedSession(session) { transport.close() }
    }

    override suspend fun revoke(stored: StoredSession) {
        synchronized(revokedSessions) { revokedSessions += stored }
    }
}
