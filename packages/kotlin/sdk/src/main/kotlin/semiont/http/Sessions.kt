package semiont.http

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import semiont.SemiontClient
import semiont.channels.BRIDGED_CHANNELS
import semiont.errors.SessionError
import semiont.errors.SessionErrorCode
import semiont.session.SemiontSession
import semiont.session.SessionEndReason
import semiont.signin.SignInKept
import semiont.telemetry.futureOf
import semiont.types.HttpEndpoint
import semiont.types.KbTarget
import semiont.types.LocalEndpoint
import semiont.types.UserResponse
import java.util.concurrent.CompletableFuture
import java.util.function.Consumer

/** A kept sign-in's renewals at its issuer, one at a time: a renewal asked for while one is under way is that one, and whoever stops waiting does not stop it. */
private class Renewing(private val kept: SignInKept, private val token: StateFlow<String?>) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var underWay: Deferred<String?>? = null

    suspend operator fun invoke(): String? {
        val renewal = synchronized(this) {
            underWay ?: scope.async {
                try {
                    renewKept(kept, token.value)
                } finally {
                    synchronized(this@Renewing) { underWay = null }
                }
            }.also { underWay = it }
        }
        return renewal.await()
    }

    /** End the renewal under way, when there is one: nobody is left to give its token to. */
    fun close(): Unit = scope.cancel()
}

/** Ask the gateway who a token is: one request, by a caller that holds nothing else. No stream is opened for it, and nothing renews the token: a refusal is the answer. */
private fun asking(baseUrl: String): suspend (String) -> UserResponse = { token ->
    HttpTransport(baseUrl, MutableStateFlow(token), emptyList()).use { it.getCurrentUser() }
}

/** The origin of the gateway `kb` is reached at. Throws `SessionError` (`session.construct-failed`) for a knowledge base reached otherwise than over HTTP, or whose host is no host's name. */
private fun gatewayOf(kb: KbTarget): String {
    val endpoint = kb.endpoint as? HttpEndpoint
        ?: throw SessionError(SessionErrorCode.ConstructFailed, "A session over HTTP cannot be built for endpoint kind \"${(kb.endpoint as LocalEndpoint).kind.value}\"", kb.id)
    return try {
        gatewayUrl(endpoint)
    } catch (invalid: IllegalArgumentException) {
        throw SessionError(SessionErrorCode.ConstructFailed, invalid.message ?: "Invalid KB hostname", kb.id)
    }
}

/**
 * A session over HTTP with the transport and the client it was opened with:
 * closing it ends the session, then the client, then the transport.
 */
public class OpenedSession internal constructor(
    public val session: SemiontSession,
    private val content: HttpContentTransport,
    private val transport: HttpTransport,
    private val renewing: AutoCloseable,
) : AutoCloseable {
    /** The session's client. */
    public val client: SemiontClient get() = session.client

    override fun close() {
        session.close()
        session.client.close()
        renewing.close()
        content.close()
        transport.close()
    }
}

/**
 * A session with the knowledge base `kb`, at the gateway its endpoint names,
 * over the sign-in `kept` holds: open, and ready. A token the gateway refuses
 * is renewed through the session, so the transport and the session never hold
 * different ones. With nothing kept, the session is signed out: its token is
 * null, and a request made through its client is refused. `validate` is
 * whether the gateway is asked who the token is; `channels` are the global
 * channels the transport's stream names. Throws `SessionError`
 * (`session.construct-failed`), before anything is asked, for a knowledge base
 * that is not reached over HTTP or whose host is no host's name.
 */
public suspend fun sessionFromKept(
    kb: KbTarget,
    kept: SignInKept,
    validate: Boolean = true,
    channels: List<String> = BRIDGED_CHANNELS,
    onAuthFailed: ((SessionEndReason) -> Unit)? = null,
    onError: ((SessionError) -> Unit)? = null,
): OpenedSession {
    val baseUrl = gatewayOf(kb)
    val token = MutableStateFlow<String?>(null)
    val renewing = Renewing(kept, token)
    // The transport's refresher is made before the session that answers it: it waits for that session,
    // and closing the transport ends the wait (SDK-FOLLOW-UPS item 16).
    val made = CompletableDeferred<SemiontSession>()
    val transport = HttpTransport(baseUrl, token, channels, refresher = object : TokenRefresher {
        override suspend fun refresh(refused: String?): String? = made.await().refresh()
    })
    val content = HttpContentTransport(transport)
    val client = SemiontClient(transport, content, transport)
    val session = SemiontSession(kb, client, token, kept, { renewing() }, if (validate) asking(baseUrl) else null, onAuthFailed, onError)
    made.complete(session)
    val opened = OpenedSession(session, content, transport, AutoCloseable { renewing.close() })
    try {
        session.start()
        session.ready()
    } catch (failure: Throwable) {
        // A session that did not start leaves nothing open.
        opened.close()
        throw failure
    }
    return opened
}

/** `sessionFromKept`, for Java. */
public fun sessionFromKeptFuture(
    kb: KbTarget,
    kept: SignInKept,
    validate: Boolean,
    channels: List<String>,
    onAuthFailed: Consumer<SessionEndReason>?,
    onError: Consumer<SessionError>?,
): CompletableFuture<OpenedSession> = CoroutineScope(Dispatchers.Default).futureOf {
    sessionFromKept(kb, kept, validate, channels, onAuthFailed?.let { told -> { told.accept(it) } }, onError?.let { told -> { told.accept(it) } })
}
