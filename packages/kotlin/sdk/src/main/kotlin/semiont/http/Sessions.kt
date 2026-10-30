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
import semiont.errors.SignInError
import semiont.registry.SemiontBrowser
import semiont.registry.SessionFactory
import semiont.registry.SessionFactoryOptions
import semiont.registry.SignInOutcome
import semiont.registry.SignedIn
import semiont.registry.StoredSession
import semiont.registry.keptIn
import semiont.session.OpenedSession
import semiont.session.SemiontSession
import semiont.session.SessionEndReason
import semiont.signin.BROWSER_CLIENT_ID
import semiont.signin.SignInKept
import semiont.storage.CachePersistence
import semiont.storage.CoupledBookmarks
import semiont.storage.SessionStorage
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
 * The session of `kb` as soon as it has started, before it is ready: what a
 * registry holds, and waits on itself. With a `storage`, what the client's
 * small queries hold is kept there under the knowledge base's id, and the
 * stream's place in each scope with it.
 */
internal suspend fun sessionStarted(
    kb: KbTarget,
    kept: SignInKept,
    validate: Boolean,
    channels: List<String>,
    storage: SessionStorage?,
    onAuthFailed: ((SessionEndReason) -> Unit)?,
    onError: ((SessionError) -> Unit)?,
): OpenedSession {
    val baseUrl = gatewayOf(kb)
    val token = MutableStateFlow<String?>(null)
    val renewing = Renewing(kept, token)
    // The stream's place rides the caches' writes, and only when every cache is at rest: a place kept ahead of a
    // cache still taking in the event it names would have the next session skip that event.
    val places = storage?.let { CoupledBookmarks(it, "semiont.lastEventId.${kb.id}") }
    // The transport's refresher is made before the session that answers it: it waits for that session,
    // and closing the transport ends the wait (SDK-FOLLOW-UPS item 16).
    val made = CompletableDeferred<SemiontSession>()
    val transport = HttpTransport(
        baseUrl,
        token,
        channels,
        refresher = object : TokenRefresher {
            override suspend fun refresh(refused: String?): String? = made.await().refreshOf(refused)
        },
        bookmarks = places,
    )
    val content = HttpContentTransport(transport)
    val client = SemiontClient(transport, content, transport, persistence = places?.let { CachePersistence(it.storage, kb.id) })
    places?.flushGate = { client.persistenceSettled }
    val session = SemiontSession(kb, client, token, kept, { renewing() }, if (validate) asking(baseUrl) else null, onAuthFailed, onError)
    made.complete(session)
    val opened = OpenedSession(session) {
        renewing.close()
        content.close()
        transport.close()
    }
    try {
        session.start()
    } catch (failure: Throwable) {
        // A session that did not start leaves nothing open.
        opened.close()
        throw failure
    }
    return opened
}

/**
 * A session with the knowledge base `kb`, at the gateway its endpoint names,
 * over the sign-in `kept` holds: open, and ready. A token the gateway refuses
 * is renewed through the session, so the transport and the session never hold
 * different ones. With nothing kept, the session is signed out: its token is
 * null, and a request made through its client is refused. `validate` is
 * whether the gateway is asked who the token is; `channels` are the global
 * channels the transport's stream names. With a `storage`, what the client's
 * small queries hold is kept there under the knowledge base's id, and the
 * stream's place in each scope with it: the next session over the same
 * storage shows what was kept at once, and is sent what was recorded since.
 * Throws `SessionError` (`session.construct-failed`), before anything is
 * asked, for a knowledge base that is not reached over HTTP or whose host is
 * no host's name.
 */
public suspend fun sessionFromKept(
    kb: KbTarget,
    kept: SignInKept,
    validate: Boolean = true,
    channels: List<String> = BRIDGED_CHANNELS,
    storage: SessionStorage? = null,
    onAuthFailed: ((SessionEndReason) -> Unit)? = null,
    onError: ((SessionError) -> Unit)? = null,
): OpenedSession {
    val opened = sessionStarted(kb, kept, validate, channels, storage, onAuthFailed, onError)
    try {
        opened.session.ready()
    } catch (failure: Throwable) {
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
    storage: SessionStorage?,
    onAuthFailed: Consumer<SessionEndReason>?,
    onError: Consumer<SessionError>?,
): CompletableFuture<OpenedSession> = CoroutineScope(Dispatchers.Default).futureOf {
    sessionFromKept(kb, kept, validate, channels, storage, onAuthFailed?.let { told -> { told.accept(it) } }, onError?.let { told -> { told.accept(it) } })
}

// ── A registry's sessions, over HTTP ───────────────────────────────────

/**
 * Builds the session of each knowledge base a registry activates, over its
 * gateway. The session's caches, and the stream's place in each scope, are
 * kept in the registry's storage under the knowledge base's id, and its token
 * is renewed at the issuer its stored session names. Each session renews its
 * own: a knowledge base's old session and its new one, during a sign-in, are
 * closed in turn.
 */
public class HttpSessionFactory : SessionFactory {
    override suspend fun session(options: SessionFactoryOptions): OpenedSession {
        val kb = options.kb
        return sessionStarted(
            KbTarget(kb.id, kb.label, kb.endpoint),
            keptIn(options.storage, kb.id),
            true,
            BRIDGED_CHANNELS,
            options.storage,
            options.signals::notifySessionEnded,
            options.onError,
        )
    }

    override suspend fun revoke(stored: StoredSession) {
        val endpoint = stored.revocationEndpoint ?: return
        try {
            revokeAtIssuer(endpoint, stored.clientId, stored.refresh)
        } catch (_: SignInError) {
            // Best effort: an issuer that could not be told forgets the token when it expires.
        }
    }
}

// ── A registry's sign-in by a page redirect ────────────────────────────

/**
 * Begin a sign-in for a registry: find the issuer the target trusts, remember
 * the pending sign-in in the registry's storage, and give the address to send
 * the person to.
 */
public suspend fun beginSignIn(browser: SemiontBrowser, options: BeginAuthorizationOptions): String = beginAuthorization(options, browser.storage)

/** `beginSignIn`, for Java. */
public fun beginSignInFuture(browser: SemiontBrowser, options: BeginAuthorizationOptions): CompletableFuture<String> =
    CoroutineScope(Dispatchers.Default).futureOf { beginSignIn(browser, options) }

/**
 * Finish a sign-in from the address the issuer sent the person back to:
 * exchange the code, ask the knowledge base who it is, and have the registry
 * land the sign-in on the entry for the knowledge base that answered
 * (`SemiontBrowser.signedIn`). Throws `SignInError` when the grant failed, and
 * `IdentityUnverifiableError` when it succeeded and the knowledge base could
 * not say who it is: then nothing is registered, and nothing is stored.
 */
public suspend fun completeSignIn(browser: SemiontBrowser, callbackUrl: String): SignInOutcome {
    val (pending, tokens) = completeAuthorization(callbackUrl, browser.storage)
    val identity = describeConnection(pending.target, tokens.access)
    return browser.signedIn(
        SignedIn(
            endpoint = pending.target,
            description = identity.description,
            session = StoredSession(tokens.access, tokens.refresh, BROWSER_CLIENT_ID, pending.issuer.token, pending.issuer.revocation),
            kbId = pending.kbId,
            expectedDid = pending.expectedDid,
            expectedName = pending.expectedName,
        ),
    )
}

/** `completeSignIn`, for Java. */
public fun completeSignInFuture(browser: SemiontBrowser, callbackUrl: String): CompletableFuture<SignInOutcome> =
    CoroutineScope(Dispatchers.Default).futureOf { completeSignIn(browser, callbackUrl) }
