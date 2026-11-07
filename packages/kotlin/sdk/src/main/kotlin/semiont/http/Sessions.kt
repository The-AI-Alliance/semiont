package semiont.http

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import semiont.Timings
import semiont.transport.Broadcast
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
import semiont.registry.lastEventIdKey
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
import java.net.http.HttpClient
import java.util.concurrent.CompletableFuture
import java.util.function.Consumer
import kotlin.coroutines.CoroutineContext
import kotlin.random.Random
import kotlin.time.TimeSource

/**
 * A kept sign-in's renewals at its issuer, one at a time: a renewal asked for
 * while one is under way is that one, and whoever stops waiting does not stop
 * it. A renewal runs on `context`, and each retry's jitter is drawn from
 * `random`.
 */
private class Renewing(
    private val kept: SignInKept,
    private val token: StateFlow<String?>,
    private val http: HttpClient,
    context: CoroutineContext,
    private val random: Random,
) {
    private val scope = CoroutineScope(context + SupervisorJob(context[Job]))
    private var underWay: Deferred<String?>? = null

    suspend operator fun invoke(): String? {
        val renewal = synchronized(this) {
            underWay ?: scope.async {
                try {
                    renewKept(kept, token.value, http, random)
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
private fun asking(baseUrl: String, http: HttpClient): suspend (String) -> UserResponse = { token ->
    Exchange(baseUrl.trimEnd('/'), http, MutableStateFlow(token), null, Broadcast(), Timings.HTTP_REQUEST_TIMEOUT_MS) { false }
        .answer(UserResponse.serializer(), "GET", "/api/users/me")
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
 * stream's place in each scope with it. The gateway and the issuer are asked
 * with `http`. What it builds runs on `context`, keeps `clock`, and draws its
 * jitter from `random`.
 */
internal suspend fun sessionStarted(
    kb: KbTarget,
    kept: SignInKept,
    validate: Boolean,
    channels: List<String>,
    storage: SessionStorage?,
    onAuthFailed: ((SessionEndReason) -> Unit)?,
    onError: ((SessionError) -> Unit)?,
    http: HttpClient,
    context: CoroutineContext,
    clock: TimeSource,
    random: Random,
): OpenedSession {
    val baseUrl = gatewayOf(kb)
    val token = MutableStateFlow<String?>(null)
    val renewing = Renewing(kept, token, http, context, random)
    // The stream's place rides the caches' writes, and only when every cache is at rest: a place kept ahead of a
    // cache still taking in the event it names would have the next session skip that event.
    val places = storage?.let { CoupledBookmarks(it, lastEventIdKey(kb.id)) }
    // The transport's refresher is made before the session that answers it: it waits for that session,
    // and closing the transport ends the wait (SDK-FOLLOW-UPS item 16).
    val made = CompletableDeferred<SemiontSession>()
    val transport = HttpTransport(
        baseUrl,
        token,
        channels,
        refresher = object : TokenRefresher {
            override suspend fun refresh(refused: String?): String? = made.await().refresh(refused)
        },
        bookmarks = places,
        http = http,
        context = context,
        clock = clock,
        random = random,
    )
    val content = HttpContentTransport(transport)
    val client = SemiontClient(transport, content, transport, persistence = places?.let { CachePersistence(it.storage, kb.id) }, context = context, clock = clock)
    places?.flushGate = { client.persistenceSettled }
    val session = SemiontSession(kb, client, token, kept, { renewing() }, if (validate) asking(baseUrl, http) else null, onAuthFailed, onError, random)
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
 * The gateway and the issuer are asked with `http`. The session, its client
 * and its renewals run on `context`, keep `clock`, and draw their jitter from
 * `random`. Throws `SessionError` (`session.construct-failed`), before
 * anything is asked, for a knowledge base that is not reached over HTTP or
 * whose host is no host's name.
 */
public suspend fun sessionFromKept(
    kb: KbTarget,
    kept: SignInKept,
    validate: Boolean = true,
    channels: List<String> = BRIDGED_CHANNELS,
    storage: SessionStorage? = null,
    onAuthFailed: ((SessionEndReason) -> Unit)? = null,
    onError: ((SessionError) -> Unit)? = null,
    http: HttpClient = ownHttp,
    context: CoroutineContext = Dispatchers.Default,
    clock: TimeSource = TimeSource.Monotonic,
    random: Random = Random.Default,
): OpenedSession {
    val opened = sessionStarted(kb, kept, validate, channels, storage, onAuthFailed, onError, http, context, clock, random)
    try {
        opened.session.ready()
    } catch (failure: Throwable) {
        opened.close()
        throw failure
    }
    return opened
}

/** `sessionFromKept`, for Java, on `context`. */
@JvmOverloads
public fun sessionFromKeptFuture(
    kb: KbTarget,
    kept: SignInKept,
    validate: Boolean,
    channels: List<String>,
    storage: SessionStorage?,
    onAuthFailed: Consumer<SessionEndReason>?,
    onError: Consumer<SessionError>?,
    http: HttpClient = ownHttp,
    context: CoroutineContext = Dispatchers.Default,
    clock: TimeSource = TimeSource.Monotonic,
    random: Random = Random.Default,
): CompletableFuture<OpenedSession> = CoroutineScope(context).futureOf {
    sessionFromKept(kb, kept, validate, channels, storage, onAuthFailed?.let { told -> { told.accept(it) } }, onError?.let { told -> { told.accept(it) } }, http, context, clock, random)
}

// ── A registry's sessions, over HTTP ───────────────────────────────────

/**
 * Builds the session of each knowledge base a registry activates, over its
 * gateway. The session's caches, and the stream's place in each scope, are
 * kept in the registry's storage under the knowledge base's id, and its token
 * is renewed at the issuer its stored session names. Each session renews its
 * own: a knowledge base's old session and its new one, during a sign-in, are
 * closed in turn. Every gateway and issuer is asked with `http`. Its sessions
 * run on `context`, keep `clock`, and draw their jitter from `random`, and so
 * do its futures.
 */
public class HttpSessionFactory @JvmOverloads constructor(
    private val http: HttpClient = ownHttp,
    private val context: CoroutineContext = Dispatchers.Default,
    private val clock: TimeSource = TimeSource.Monotonic,
    private val random: Random = Random.Default,
) : SessionFactory {
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
            http,
            context,
            clock,
            random,
        )
    }

    override fun sessionFuture(options: SessionFactoryOptions): CompletableFuture<OpenedSession> = CoroutineScope(context).futureOf { session(options) }

    override fun revokeFuture(stored: StoredSession): CompletableFuture<Unit> = CoroutineScope(context).futureOf { revoke(stored) }

    override suspend fun revoke(stored: StoredSession) {
        val endpoint = stored.revocationEndpoint ?: return
        try {
            revokeAtIssuer(endpoint, stored.clientId, stored.refresh, http)
        } catch (_: SignInError) {
            // Best effort: an issuer that could not be told forgets the token when it expires.
        }
    }
}

// ── A registry's sign-in by a page redirect ────────────────────────────

/**
 * Begin a sign-in for a registry: find the issuer the target trusts, remember
 * the pending sign-in in the registry's storage, and give the address to send
 * the person to. The target and its issuer are asked with `http`, on the
 * browser's context.
 */
public suspend fun beginSignIn(browser: SemiontBrowser, options: BeginAuthorizationOptions, http: HttpClient = ownHttp): String =
    withContext(browser.context) { beginAuthorization(options, browser.storage, http) }

/** `beginSignIn`, for Java, on the browser's context. */
@JvmOverloads
public fun beginSignInFuture(browser: SemiontBrowser, options: BeginAuthorizationOptions, http: HttpClient = ownHttp): CompletableFuture<String> =
    browser.future { beginSignIn(browser, options, http) }

/**
 * Finish a sign-in from the address the issuer sent the person back to:
 * exchange the code, ask the knowledge base who it is, and have the registry
 * land the sign-in on the entry for the knowledge base that answered
 * (`SemiontBrowser.signedIn`). Throws `SignInError` when the grant failed, and
 * `IdentityUnverifiableError` when it succeeded and the knowledge base could
 * not say who it is: then nothing is registered, and nothing is stored. The
 * issuer and the knowledge base are asked with `http`, on the browser's
 * context, by its clock and random source.
 */
public suspend fun completeSignIn(browser: SemiontBrowser, callbackUrl: String, http: HttpClient = ownHttp): SignInOutcome = withContext(browser.context) {
    val (pending, tokens) = completeAuthorization(callbackUrl, browser.storage, http)
    val identity = describeConnection(pending.target, tokens.access, http, browser.clock, browser.random)
    browser.signedIn(
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

/** `completeSignIn`, for Java, on the browser's context. */
@JvmOverloads
public fun completeSignInFuture(browser: SemiontBrowser, callbackUrl: String, http: HttpClient = ownHttp): CompletableFuture<SignInOutcome> =
    browser.future { completeSignIn(browser, callbackUrl, http) }
