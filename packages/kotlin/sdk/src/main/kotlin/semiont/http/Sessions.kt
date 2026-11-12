package semiont.http

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.job
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import semiont.KeptWrites
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
    private val http: HttpClient,
    context: CoroutineContext,
    private val random: Random,
) {
    private val scope = CoroutineScope(context + SupervisorJob(context[Job]))
    private var underWay: Deferred<String?>? = null

    /** Renew `holding`, the token the session renews (`renewKept`): none only for a session that has held none. */
    suspend operator fun invoke(holding: String?): String? {
        val renewal = synchronized(this) {
            underWay ?: scope.async {
                try {
                    renewKept(kept, holding, http, random)
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

/**
 * What a session's client writes of what it keeps for one person, each write
 * one step with its check: made only while the sign-in `kept` holds names
 * that person, read through `kept` before each write, whatever holds it. Once
 * it does not (the saved sign-in forgotten, however it was, or another sign-in
 * kept in its place, here or in another context, or it cannot be read, which
 * the session says), what was owed is dropped,
 * and nothing more is written for the rest of the client's life, so nothing
 * forgetting deleted is put back. A renewal keeps the person, and changes
 * nothing. The session's own forgetting of its sign-in (`forgetting`) stops
 * the writes first (`stop`), once the write under way has landed, so none
 * lands after what it deletes; a registry that closes the session before it
 * deletes stops them too. A write that waits for its turn waits on `context`.
 * A write the storage refuses, a cache's or that of the places riding it, is
 * said through `say` (`session.save-refused`, with what the storage said) and
 * owed still (`owesARefusedWrite`), until a write of its key is made, or the
 * client's closing flush makes it (`writeRefused`): nothing is thrown at
 * whoever asked for it, nor into any scope.
 */
private class WhileNamed(
    private val kept: SignInKept,
    private val kbId: String,
    context: CoroutineContext,
    private val say: suspend (SessionError) -> Unit,
) : KeptWrites {
    private val turn = Mutex()
    private val writing = CoroutineScope(context + SupervisorJob(context[Job]))

    // Read and written only while `turn` is held.
    private var dropped = false

    /** A write of one key, made for the person whose key is `personKey`. */
    private class Write(val personKey: String, val change: () -> Unit)

    /** Each write the storage refused, by its key. Written only while `turn` is held, and guarded by itself. */
    private val refusedWrites = LinkedHashMap<String, Write>()

    override val owesARefusedWrite: Boolean
        get() = synchronized(refusedWrites) { refusedWrites.isNotEmpty() }

    /**
     * Make `write` of `key`, while its person is named: it stands for any
     * write of `key` owed before it. One the storage refuses is said, and owed
     * still. Called while `turn` is held.
     */
    private suspend fun make(key: String, write: Write) {
        if (!dropped && !names(write.personKey)) drop()
        if (dropped) return
        synchronized(refusedWrites) { refusedWrites.remove(key) }
        try {
            write.change()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (refused: Exception) {
            synchronized(refusedWrites) { refusedWrites[key] = write }
            say(SessionError(SessionErrorCode.SaveRefused, "The storage refused a write of what the client keeps: $refused", kbId))
        }
    }

    /** Nothing more is written, and nothing is owed. Called while `turn` is held. */
    private fun drop() {
        dropped = true
        synchronized(refusedWrites) { refusedWrites.clear() }
    }

    /**
     * Whether `kept`'s sign-in names the person whose key is `personKey`. One
     * that cannot be read is not known to: the session says so
     * (`session.keep-failed`), once, as nothing is asked or written after.
     * Called while `turn` is held.
     */
    private suspend fun names(personKey: String): Boolean = try {
        kept.held()?.personKey == personKey
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (unread: Exception) {
        say(SessionError(SessionErrorCode.KeepFailed, "The sign-in could not be read before the client saved what it keeps: $unread", kbId))
        false
    }

    /** `beneath`, written only while `kept`'s sign-in names the person whose key is `personKey`. */
    fun over(beneath: SessionStorage, personKey: String): SessionStorage = object : SessionStorage {
        // Begun in this thread: while no other write has the turn and `kept` answers without waiting, as the sign-ins
        // the SDK keeps do, it is made before the caller goes on, so a client's closing writes what it owes before it
        // has closed. A write that waited for its turn is made once its caller has gone on.
        private fun write(key: String, change: () -> Unit) {
            val made = Write(personKey, change)
            writing.launch(start = CoroutineStart.UNDISPATCHED) { turn.withLock { make(key, made) } }
        }

        override fun get(key: String): String? = beneath.get(key)

        override fun set(key: String, value: String) = write(key) { beneath.set(key, value) }

        override fun delete(key: String) = write(key) { beneath.delete(key) }

        override fun update(key: String, change: (String?) -> String?) = write(key) { beneath.update(key, change) }

        override fun subscribe(onChange: (key: String, value: String?) -> Unit): AutoCloseable? = beneath.subscribe(onChange)
    }

    /**
     * Make each write owed since the storage refused it, in turn, as the
     * client's closing flush does. One refused again is said again, and is
     * lost with the client.
     */
    override fun writeRefused() {
        writing.launch(start = CoroutineStart.UNDISPATCHED) {
            turn.withLock {
                for ((key, write) in synchronized(refusedWrites) { refusedWrites.toList() }) make(key, write)
            }
        }
    }

    override suspend fun landed(): Unit = writing.coroutineContext.job.children.toList().joinAll()

    /** Stop every write: one under way lands first, and none is made after, nor owed. */
    suspend fun stop(): Unit = turn.withLock { drop() }

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
 * person whose key is `personKey`: the caches, each write made only while the
 * session's sign-in names the person (`named`), and the stream's places, which
 * ride the caches' writes, in the same turn, once a cache's write has landed.
 */
private class KeptFor(storage: SessionStorage, kbId: String, personKey: String, named: WhileNamed) {
    val places = CoupledBookmarks(storage, lastEventIdKey(kbId, personKey))
    val persistence = CachePersistence(named.over(places.storage, personKey), kbId, personKey)
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
 * small queries hold is kept there for the person the kept sign-in names, and
 * the stream's place in each scope with it: from the start when it names them
 * already, whether or not the session asks who its token is (`validate`), and
 * otherwise once the gateway has named them and that is recorded on the
 * sign-in the gateway was asked about. A session that does not ask, over a
 * sign-in that names nobody yet, keeps for nobody. Its transport's stream
 * names `BRIDGED_CHANNELS` on no scope, as a full client's does.
 * A sign-in that cannot record who the gateway named keeps nothing more, and
 * the session says so once (`session.keep-failed`); it goes on, its token held
 * and its person signed in. The gateway and the issuer are asked with `http`.
 * What it builds runs on `context`, keeps `clock`, and draws its jitter from
 * `random`.
 */
internal suspend fun sessionStarted(
    kb: KbTarget,
    kept: SignInKept,
    validate: Boolean,
    storage: SessionStorage?,
    onAuthFailed: ((SessionEndReason) -> Unit)?,
    http: HttpClient,
    context: CoroutineContext,
    clock: TimeSource,
    random: Random,
): OpenedSession {
    val baseUrl = gatewayOf(kb)
    val token = MutableStateFlow<String?>(null)
    val renewing = Renewing(kept, http, context, random)
    // The transport's refresher is made before the session that answers it: it waits for that session,
    // and closing the transport ends the wait (SDK-FOLLOW-UPS item 16).
    val made = CompletableDeferred<SemiontSession>()
    // What the client's writes meet is said by the session they are made for, which is made before any write is.
    val named = WhileNamed(kept, kb.id, context) { made.await().say(it) }
    // Kept for the person the sign-in names already, whether or not the session asks who its token is.
    val atStart = storage?.let { into -> kept.held()?.personKey?.let { person -> KeptFor(into, kb.id, person, named) } }
    val transport = HttpTransport(
        baseUrl,
        token,
        BRIDGED_CHANNELS,
        refresher = object : TokenRefresher {
            override suspend fun refresh(refused: String?): String? = made.await().refresh(refused)
        },
        bookmarks = atStart?.places,
        http = http,
        context = context,
        clock = clock,
        random = random,
    )
    val content = HttpContentTransport(transport)
    val client = SemiontClient(transport, content, transport, persistence = atStart?.persistence, context = context, clock = clock)
    // The client's caches write through `named`, which makes each write in its turn, and keeps one the storage refused
    // until it is made: the client's closing flush makes it, and the session's errors end once the writes begun have landed.
    client.writes = named
    // The stream's place rides the caches' writes, and only when every cache is at rest and no event's refetch is owed:
    // a place kept ahead of a cache still taking in the event it names would have the next session skip that event.
    atStart?.places?.coupleTo(client)
    val attached = AtomicBoolean(atStart != null)
    // Holds once the sign-in could not record who the gateway named: nothing more is kept, and that is said once.
    val unrecorded = AtomicBoolean(false)
    val ask = asking(baseUrl, http)
    // Who the gateway says a token is: by a session that keeps, recorded on the sign-in that holds that token, and only
    // then is anything kept for them.
    val whoIs: suspend (String) -> UserResponse = { asked ->
        val user = ask(asked)
        if (storage != null && !unrecorded.get()) {
            val person = personKey(user.did.value)
            val recorded = try {
                kept.recordPersonKey(asked, person)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                if (unrecorded.compareAndSet(false, true)) {
                    named.stop()
                    made.await().say(SessionError(SessionErrorCode.KeepFailed, "The sign-in could not record who the gateway named: $failure", kb.id))
                }
                false
            }
            if (recorded && attached.compareAndSet(false, true)) {
                val late = KeptFor(storage, kb.id, person, named)
                late.places.coupleTo(client)
                client.attach(late.persistence)
                transport.keepPlaces(late.places)
            }
        }
        user
    }
    val session = SemiontSession(kb, client, token, named.forgetting, { holding -> renewing(holding) }, if (validate) whoIs else null, onAuthFailed, random)
    made.complete(session)
    // Closed after the client and the session.
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
 * whether the gateway is asked who the token is. Its transport's stream names
 * `BRIDGED_CHANNELS` on no scope, as a full client's does. With a `storage`,
 * what the client's small queries hold is kept there for the person the kept
 * sign-in names, and
 * the stream's place in each scope with it: from the start when it names them
 * already, whether or not the gateway is asked, and otherwise once the gateway
 * has said who the token is and that is recorded on `kept`. The next session
 * over the same storage for them shows what was kept at once, and is sent
 * what was recorded since. A session that does not ask, over a sign-in that
 * names nobody yet, keeps for nobody; so does one where `kept` has no place
 * to record a person (the sign-in store of `semiont login`). Each write is made only while the
 * sign-in `kept` holds names the person, read through `kept` before it: once
 * that sign-in is forgotten, or another is kept in its place, nothing more is
 * written. Where `kept` is the knowledge base's sign-in as `keptIn` keeps it
 * in this `storage`, forgetting it, or keeping a new sign-in in its place,
 * deletes what was kept for them, and the client puts none of it back.
 * A write the storage refuses is said on the session's errors
 * (`session.save-refused`) and owed still, for the client's next change or
 * its closing to make; what went wrong the session says there, once, and
 * of what it said before its first reader came, the latest
 * `errorsKeptForFirstReaderCount` are kept for that reader. Closing
 * what this gives closes the client first, so what its closing flush meets is
 * said before the errors end. The gateway and the issuer are asked with
 * `http`. The session, its client, its renewals and its writes of what it
 * keeps run on `context`, keep `clock`, and draw their jitter from `random`.
 * Throws what reading `kept` threw, when it cannot be read as the session
 * starts, and `SessionError` (`session.construct-failed`), before anything is
 * asked, for a knowledge base that is not reached over HTTP or whose host is
 * no host's name.
 */
public suspend fun sessionFromKept(
    kb: KbTarget,
    kept: SignInKept,
    validate: Boolean = true,
    storage: SessionStorage? = null,
    onAuthFailed: ((SessionEndReason) -> Unit)? = null,
    http: HttpClient = ownHttp,
    context: CoroutineContext = Dispatchers.Default,
    clock: TimeSource = TimeSource.Monotonic,
    random: Random = Random.Default,
): OpenedSession {
    val opened = sessionStarted(kb, kept, validate, storage, onAuthFailed, http, context, clock, random)
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
    storage: SessionStorage?,
    onAuthFailed: Consumer<SessionEndReason>?,
    http: HttpClient = ownHttp,
    context: CoroutineContext = Dispatchers.Default,
    clock: TimeSource = TimeSource.Monotonic,
    random: Random = Random.Default,
): CompletableFuture<OpenedSession> = CoroutineScope(context).futureOf {
    sessionFromKept(kb, kept, validate, storage, onAuthFailed?.let { told -> { told.accept(it) } }, http, context, clock, random)
}

// ── A registry's sessions, over HTTP ───────────────────────────────────

/**
 * Builds the session of each knowledge base a registry activates, over its
 * gateway. The session's caches, and the stream's place in each scope, are
 * kept in the registry's storage for the person its gateway says the token
 * is, while the stored sign-in names them, and its token is renewed at the
 * issuer its stored session names. Each session renews its own: a knowledge
 * base's old session and its new one, during a sign-in, are closed in turn.
 * Every gateway and issuer is asked with `http`. Its sessions run on
 * `context`, keep `clock`, and draw their jitter from `random`, and so do its
 * futures.
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
            options.storage,
            options.signals::notifySessionEnded,
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
