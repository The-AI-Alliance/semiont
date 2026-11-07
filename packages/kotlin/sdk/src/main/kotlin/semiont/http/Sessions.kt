package semiont.http

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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
import semiont.registry.personKey
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
import java.util.concurrent.atomic.AtomicBoolean
import java.util.function.Consumer

/** A kept sign-in's renewals at its issuer, one at a time: a renewal asked for while one is under way is that one, and whoever stops waiting does not stop it. */
private class Renewing(private val kept: SignInKept, private val token: StateFlow<String?>, private val http: HttpClient) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var underWay: Deferred<String?>? = null

    suspend operator fun invoke(): String? {
        val renewal = synchronized(this) {
            underWay ?: scope.async {
                try {
                    renewKept(kept, token.value, http)
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
    HttpTransport(baseUrl, MutableStateFlow(token), emptyList(), http = http).use { it.getCurrentUser() }
}

/**
 * What a session's client writes of what it keeps for one person, each write
 * one step with its check: made only while the sign-in `kept` holds names
 * that person, read through `kept` before each write, whatever holds it. Once
 * it does not (the saved sign-in forgotten, however it was, or another sign-in
 * kept in its place, here or in another context, or it cannot be read, which
 * the session is told), what was owed is dropped,
 * and nothing more is written for the rest of the client's life, so nothing
 * forgetting deleted is put back. A renewal keeps the person, and changes
 * nothing. The session's own forgetting of its sign-in (`forgetting`) stops
 * the writes first (`stop`), once the write under way has landed, so none
 * lands after what it deletes; a registry that closes the session before it
 * deletes stops them too.
 */
private class WhileNamed(private val kept: SignInKept, private val kbId: String, private val onError: ((SessionError) -> Unit)?) {
    private val turn = Mutex()
    private val writing = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    // Read and written only while `turn` is held.
    private var dropped = false

    /**
     * Whether `kept`'s sign-in names the person whose key is `personKey`. One
     * that cannot be read is not known to: the session is told so
     * (`session.keep-failed`), once, as nothing is asked or written after.
     * Called while `turn` is held.
     */
    private suspend fun names(personKey: String): Boolean = try {
        kept.held()?.personKey == personKey
    } catch (unread: Exception) {
        onError?.invoke(SessionError(SessionErrorCode.KeepFailed, "The sign-in could not be read before the client saved what it keeps: $unread", kbId))
        false
    }

    /** `beneath`, written only while `kept`'s sign-in names the person whose key is `personKey`. */
    fun over(beneath: SessionStorage, personKey: String): SessionStorage = object : SessionStorage {
        // Begun in this thread: while no other write has the turn and `kept` answers without waiting, as the sign-ins
        // the SDK keeps do, it is made before the caller goes on, so a client's closing writes what it owes before it
        // has closed.
        private fun write(change: () -> Unit) {
            writing.launch(start = CoroutineStart.UNDISPATCHED) {
                turn.withLock {
                    if (!dropped && !names(personKey)) dropped = true
                    if (!dropped) change()
                }
            }
        }

        override fun get(key: String): String? = beneath.get(key)

        override fun set(key: String, value: String) = write { beneath.set(key, value) }

        override fun delete(key: String) = write { beneath.delete(key) }

        override fun update(key: String, change: (String?) -> String?) = write { beneath.update(key, change) }

        override fun subscribe(onChange: (key: String, value: String?) -> Unit): AutoCloseable? = beneath.subscribe(onChange)
    }

    /** Stop every write: one under way lands first, and none is made after. */
    suspend fun stop(): Unit = turn.withLock { dropped = true }

    /** `kept`, as the session holds it: its forgetting stops every write before the sign-in is forgotten. */
    val forgetting: SignInKept = object : SignInKept by kept {
        override suspend fun forget() {
            stop()
            kept.forget()
        }
    }
}

/**
 * What a session's client keeps in `storage` of knowledge base `kbId` for the
 * person whose key is `personKey`: the stream's places, which ride the
 * caches' writes, and the caches, each write made only while the session's
 * sign-in names the person (`named`).
 */
private class KeptFor(storage: SessionStorage, kbId: String, personKey: String, named: WhileNamed) {
    val places = CoupledBookmarks(named.over(storage, personKey), lastEventIdKey(kbId, personKey))
    val persistence = CachePersistence(places.storage, kbId, personKey)
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
 * registry holds, and waits on itself. With a `storage` and `validate`, what
 * the client's small queries hold is kept there for the person the gateway
 * says the token is, and the stream's place in each scope with it: from the
 * start when the kept sign-in names them already, and otherwise once the
 * gateway has named them and that is recorded on the sign-in the gateway was
 * asked about. A session that never asks who its token is keeps nothing.
 * The gateway and the issuer are asked with `http`.
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
): OpenedSession {
    val baseUrl = gatewayOf(kb)
    val token = MutableStateFlow<String?>(null)
    val renewing = Renewing(kept, token, http)
    val keeping = storage?.takeIf { validate }
    val named = WhileNamed(kept, kb.id, onError)
    val atStart = keeping?.let { into -> kept.held()?.personKey?.let { person -> KeptFor(into, kb.id, person, named) } }
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
        bookmarks = atStart?.places,
        http = http,
    )
    val content = HttpContentTransport(transport)
    val client = SemiontClient(transport, content, transport, persistence = atStart?.persistence)
    // The stream's place rides the caches' writes, and only when every cache is at rest and no event's refetch is owed:
    // a place kept ahead of a cache still taking in the event it names would have the next session skip that event.
    atStart?.places?.let(client::keepPlacesIn)
    val attached = AtomicBoolean(atStart != null)
    val ask = asking(baseUrl, http)
    // Who the gateway says a token is: by a session that keeps, recorded on the sign-in that holds that token, and only
    // then is anything kept for them.
    val whoIs: suspend (String) -> UserResponse = { asked ->
        val user = ask(asked)
        val person = personKey(user.did.value)
        if (keeping != null && kept.recordPersonKey(asked, person) && attached.compareAndSet(false, true)) {
            val late = KeptFor(keeping, kb.id, person, named)
            client.keepPlacesIn(late.places)
            client.attach(late.persistence)
            transport.keepPlaces(late.places)
        }
        user
    }
    val session = SemiontSession(kb, client, token, named.forgetting, { renewing() }, if (validate) whoIs else null, onAuthFailed, onError)
    made.complete(session)
    val built = AutoCloseable {
        renewing.close()
        content.close()
        transport.close()
    }
    val opened = OpenedSession(session, built, named::stop)
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
 * channels the transport's stream names. With a `storage`, and `validate`,
 * what the client's small queries hold is kept there for the person the
 * gateway says the token is, once that is recorded on `kept`, and the
 * stream's place in each scope with it: the next session over the same
 * storage for them shows what was kept at once, and is sent what was recorded
 * since. Where `kept` has no place to record a person (the sign-in store of
 * `semiont login`), nothing is kept. Each write is made only while the
 * sign-in `kept` holds names the person, read through `kept` before it: once
 * that sign-in is forgotten, or another is kept in its place, nothing more is
 * written. Where `kept` is the knowledge base's sign-in as `keptIn` keeps it
 * in this `storage`, forgetting it, or keeping a new sign-in in its place,
 * deletes what was kept for them, and the client puts none of it back.
 * The gateway and the issuer are asked with `http`. Throws `SessionError`
 * (`session.construct-failed`), before anything is asked, for a knowledge
 * base that is not reached over HTTP or whose host is no host's name.
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
): OpenedSession {
    val opened = sessionStarted(kb, kept, validate, channels, storage, onAuthFailed, onError, http)
    try {
        opened.session.ready()
    } catch (failure: Throwable) {
        opened.close()
        throw failure
    }
    return opened
}

/** `sessionFromKept`, for Java. */
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
): CompletableFuture<OpenedSession> = CoroutineScope(Dispatchers.Default).futureOf {
    sessionFromKept(kb, kept, validate, channels, storage, onAuthFailed?.let { told -> { told.accept(it) } }, onError?.let { told -> { told.accept(it) } }, http)
}

// ── A registry's sessions, over HTTP ───────────────────────────────────

/**
 * Builds the session of each knowledge base a registry activates, over its
 * gateway. The session's caches, and the stream's place in each scope, are
 * kept in the registry's storage for the person its gateway says the token
 * is, while the stored sign-in names them, and its token is renewed at the
 * issuer its stored session names. Each session renews its own: a knowledge
 * base's old session and its new one, during a sign-in, are closed in turn.
 * Every gateway and issuer is asked with `http`.
 */
public class HttpSessionFactory @JvmOverloads constructor(private val http: HttpClient = ownHttp) : SessionFactory {
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
        )
    }

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
 * the person to. The target and its issuer are asked with `http`.
 */
public suspend fun beginSignIn(browser: SemiontBrowser, options: BeginAuthorizationOptions, http: HttpClient = ownHttp): String =
    beginAuthorization(options, browser.storage, http)

/** `beginSignIn`, for Java. */
@JvmOverloads
public fun beginSignInFuture(browser: SemiontBrowser, options: BeginAuthorizationOptions, http: HttpClient = ownHttp): CompletableFuture<String> =
    CoroutineScope(Dispatchers.Default).futureOf { beginSignIn(browser, options, http) }

/**
 * Finish a sign-in from the address the issuer sent the person back to:
 * exchange the code, ask the knowledge base who it is, and have the registry
 * land the sign-in on the entry for the knowledge base that answered
 * (`SemiontBrowser.signedIn`). Throws `SignInError` when the grant failed, and
 * `IdentityUnverifiableError` when it succeeded and the knowledge base could
 * not say who it is: then nothing is registered, and nothing is stored. The
 * issuer and the knowledge base are asked with `http`.
 */
public suspend fun completeSignIn(browser: SemiontBrowser, callbackUrl: String, http: HttpClient = ownHttp): SignInOutcome {
    val (pending, tokens) = completeAuthorization(callbackUrl, browser.storage, http)
    val identity = describeConnection(pending.target, tokens.access, http)
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
@JvmOverloads
public fun completeSignInFuture(browser: SemiontBrowser, callbackUrl: String, http: HttpClient = ownHttp): CompletableFuture<SignInOutcome> =
    CoroutineScope(Dispatchers.Default).futureOf { completeSignIn(browser, callbackUrl, http) }
