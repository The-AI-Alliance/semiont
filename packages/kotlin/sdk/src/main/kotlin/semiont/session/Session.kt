package semiont.session

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import semiont.SemiontClient
import semiont.StateUnit
import semiont.Timings
import semiont.errors.SemiontError
import semiont.errors.SessionError
import semiont.errors.SessionErrorCode
import semiont.errors.SignInError
import semiont.errors.SignInErrorCode
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.retry.REFRESH
import semiont.retry.RetryFacts
import semiont.signin.HeldSignIn
import semiont.signin.SignInKept
import semiont.telemetry.futureOf
import semiont.transport.ConnectionState
import semiont.transport.Events
import semiont.transport.Variable
import semiont.transport.Watched
import semiont.types.KbTarget
import semiont.types.UserResponse
import java.util.UUID
import java.util.concurrent.CompletableFuture

/** Why a session ended: its issuer refused to renew its token (`EXPIRED`), or the gateway refused a token its issuer had just issued (`REFUSED`). */
public enum class SessionEndReason(
    /** The reason as every SDK spells it. */
    public val wire: String,
) {
    EXPIRED("expired"),
    REFUSED("refused"),
}

private const val JUST_ISSUED_AND_REFUSED = "The gateway refused a token its issuer had just issued"

/** Why a renewal gave no token, for whoever reads the error. */
private fun notRenewed(failure: SignInError?): String = if (failure == null) "Token refresh failed" else "Token refresh failed: ${failure.message}"

/** Whether a renewal failed because the issuer refused it: an answer the `refresh` rule does not try again. No answer, and one it tries again until the budget is spent, is no refusal. */
private fun refused(failure: SignInError): Boolean =
    failure.reason == SignInErrorCode.Exchange && failure.status != null && !REFRESH.retryable(RetryFacts(status = failure.status, method = "POST"))

private fun now(): Double = System.currentTimeMillis() / 1000.0

/**
 * A session with one knowledge base: the token its client's transport sends
 * and who is signed in, the token renewed before it expires and when the
 * gateway refuses it (specs/src/session/cases.json). It writes its token and
 * who is signed in, so it ends them; it only uses its client, so it never ends
 * it, and whoever made the client and the session ends both.
 *
 * At its start it asks the gateway who the kept token is. A token the gateway
 * refuses is renewed once and asked about once more; a token its issuer had
 * just issued and the gateway refuses is final. So the gateway is asked at most
 * twice and the issuer at most once. Whenever a token is renewed, what is kept
 * is forgotten only when the issuer refuses: a renewal that got no answer leaves
 * the session no usable token and keeps what is kept, and the next refusal
 * renews again, and so does the session on its own, on the reconnect backoff.
 */
public class SemiontSession internal constructor(
    /** The knowledge base the session is with: where it is reached, and `id`, the key its credentials are kept under. */
    public val kb: KbTarget,
    /** The client whose transport sends the session's token. */
    public val client: SemiontClient,
    private val tokens: MutableStateFlow<String?>,
    private val kept: SignInKept,
    private val renew: (suspend () -> String?)?,
    private val validate: (suspend (String) -> UserResponse)?,
    private val onAuthFailed: ((SessionEndReason) -> Unit)?,
    private val onError: ((SessionError) -> Unit)?,
) : StateUnit {
    /** Which live session this is: a new one for the same knowledge base has another. */
    public val id: String = "session-${UUID.randomUUID()}"

    private val users = Variable<UserResponse?>(null)

    // Holds once the session has ended: its token's readers end with it.
    private val ended = MutableStateFlow(false)
    private val readied = CompletableDeferred<Unit>()

    // Held while a refusal is being answered, so that the refusals that arrive during it are answered by it.
    private val answering = Mutex()

    // Holds while a renewal that got no answer is owed another attempt.
    private val unanswered = MutableStateFlow(false)

    @Volatile
    private var closing = false
    private var work: CoroutineScope? = null

    /** The token the transport sends: the present one, and each after it, until the session ends. */
    public val token: Watched<String?> = Watched(tokens, ended)

    /** Who is signed in, once the gateway has said, until the session ends. */
    public val user: Watched<UserResponse?> = users.reading()

    /** The state of the client's connection. */
    public val streamState: Watched<ConnectionState> get() = client.transport.state

    /** The failures the client's transport meets, from now on: a refusal for want of a valid token is a reason to `refresh`. */
    public fun errors(): Events<SemiontError> = client.transport.failures()

    /** When the token the session holds expires, in seconds since the epoch. */
    public fun expiresAt(): Double? = tokens.value?.let(::tokenExpiry)

    /** Wait until the session has done what it does at its start. It returns whatever that came to. */
    public suspend fun ready(): Unit = readied.await()

    /** `ready`, for Java. */
    public fun readyFuture(): CompletableFuture<Unit> = client.links.future { ready() }

    /**
     * Start the session: a kept token that is still good is what the transport
     * sends first, and the session's renewals and its start run on the
     * dispatcher of whoever starts it, as no child of theirs.
     */
    internal suspend fun start() {
        check(work == null && !closing) { "a session is started once" }
        val found = kept.held()
        if (found != null && !isTokenExpired(found.access, now()) && tokens.value == null) tokens.value = found.access
        val scope = CoroutineScope(currentCoroutineContext().minusKey(Job) + SupervisorJob())
        work = scope
        scope.launch { renewWhenDue(tokens) { renewed() } }
        scope.launch { renewWhenUnanswered() }
        scope.launch {
            try {
                begin(found)
            } finally {
                readied.complete(Unit)
            }
        }
    }

    /**
     * The gateway refused the session's token: renew it, and ask the gateway
     * who the new one is. Returns the token the session then holds, or null:
     * it holds no token, and if the issuer refused to renew a kept sign-in it is over. One refusal
     * is answered at a time, so refusals that arrive together cost one renewal
     * and one ask, and who the gateway says the renewed token is, is who is
     * signed in. A gateway that cannot be asked refuses nothing: the renewed
     * token is given.
     */
    public suspend fun refresh(): String? = refreshOf(tokens.value)

    /**
     * `refresh`, of a refusal of `refused`: the token the refused request
     * carried. A token the session has already moved past is not renewed
     * again; the one it holds now is given.
     */
    internal suspend fun refreshOf(refused: String?): String? =
        answering.withLock {
            // The first of refusals that arrive together renews and asks; the rest find the token is no longer theirs.
            if (tokens.value != refused) return@withLock tokens.value
            val renewed = renewed()
            if (renewed == null || validate == null) return@withLock renewed
            // While the session is starting, its start is what asks: it takes the renewed token up as the just-issued one.
            if (!readied.isCompleted) return@withLock renewed
            try {
                val user = validate.invoke(renewed)
                // Who the token the session still holds is, as the gateway said.
                if (!closing && tokens.value == renewed) users.set(user)
            } catch (refusal: SemiontError) {
                // Only a token the session still holds ends it: one replaced meanwhile is no longer the session's to be refused.
                val refused = refusal is TransportError && refusal.reason == TransportErrorCode.Unauthorized
                if (refused && !closing && tokens.value == renewed) {
                    signedOut(SessionEndReason.REFUSED, SessionError(SessionErrorCode.CredentialRefused, JUST_ISSUED_AND_REFUSED, kb.id))
                }
            }
            if (closing) null else tokens.value
        }

    /** `refresh`, for Java. */
    public fun refreshFuture(): CompletableFuture<String?> = client.links.future { refresh() }

    /** Ask the renewal: one that could not be made and one that was refused both leave the session without a token. */
    private suspend fun tryRefresh(): Pair<String?, SignInError?> {
        val renewing = renew ?: return null to null
        return try {
            renewing() to null
        } catch (failure: SignInError) {
            null to failure
        }
    }

    /** Renew the token at the issuer, with nobody asked afterwards: what the session does on its own schedule. */
    private suspend fun renewed(): String? {
        if (closing || renew == null) return null
        val (token, failure) = tryRefresh()
        if (closing) return null
        if (token != null) {
            unanswered.value = false
            tokens.value = token
            return token
        }
        tokens.value = null
        // A session that never had a credential cannot expire: it is signed out, which is no failure.
        if (kept.held() != null) unrenewed(failure) else unanswered.value = false
        return null
    }

    /**
     * After a renewal that got no answer, renew again on the reconnect backoff: `RECONNECT_MS`, doubling to
     * `MAX_RECONNECT_MS`. It ends when a renewal is made or refused, when a token arrives some other way, and when the
     * session ends.
     */
    private suspend fun renewWhenUnanswered() {
        while (true) {
            unanswered.first { it }
            var wait = Timings.RECONNECT_MS
            while (unanswered.value) {
                delay(wait)
                if (tokens.value != null) unanswered.value = false else if (unanswered.value) renewed()
                wait = minOf(2 * wait, Timings.MAX_RECONNECT_MS)
            }
        }
    }

    /**
     * A renewal of what is kept gave no token, and the session holds none. The issuer's refusal, or nothing left to renew
     * with, ends the session; any other failure keeps what is kept, and says why: the next refusal renews again, and so
     * does the reconnect backoff.
     */
    private suspend fun unrenewed(failure: SignInError?) {
        tokens.value = null
        val notRenewed = SessionError(SessionErrorCode.RefreshExhausted, notRenewed(failure), kb.id)
        if (failure != null && !refused(failure)) {
            unanswered.value = true
            onError?.invoke(notRenewed)
        } else {
            signedOut(SessionEndReason.EXPIRED, notRenewed)
        }
    }

    /** The session is over: its credential is forgotten, and its host is told why. The one teardown, whichever way it ended. */
    private suspend fun signedOut(told: SessionEndReason, error: SessionError) {
        unanswered.value = false
        tokens.value = null
        users.set(null)
        kept.forget()
        onAuthFailed?.invoke(told)
        onError?.invoke(error)
    }

    /**
     * What a session does at its start, with the sign-in it found kept: renew
     * it if it has expired, then ask the gateway who it is.
     */
    private suspend fun begin(found: HeldSignIn?) {
        if (found == null) return
        var justIssued = isTokenExpired(found.access, now())
        var token = found.access
        if (justIssued) {
            val (renewed, failure) = tryRefresh()
            if (renewed == null) {
                if (failure == null || refused(failure)) {
                    // There was no session to end: the sign-in is forgotten, and nothing is said.
                    kept.forget()
                } else {
                    // The issuer did not refuse it: the sign-in is kept, and renewed on the reconnect backoff or when a request is refused.
                    unanswered.value = true
                    onError?.invoke(SessionError(SessionErrorCode.AuthFailed, notRenewed(failure), kb.id))
                }
                return
            }
            token = renewed
            tokens.value = token
        }
        val asking = validate ?: return
        while (!closing) {
            try {
                users.set(asking(token))
                return
            } catch (refusal: TransportError) {
                if (refusal.reason != TransportErrorCode.Unauthorized) {
                    onError?.invoke(SessionError(SessionErrorCode.AuthFailed, refusal.message ?: "", kb.id))
                    return
                }
            } catch (other: SemiontError) {
                onError?.invoke(SessionError(SessionErrorCode.AuthFailed, other.message ?: "", kb.id))
                return
            }
            if (closing) return
            if (justIssued) {
                signedOut(SessionEndReason.REFUSED, SessionError(SessionErrorCode.CredentialRefused, JUST_ISSUED_AND_REFUSED, kb.id))
                return
            }
            // Seen, and renewed, under the lock a refusal is answered under: a renewal `refresh` makes meanwhile is seen here,
            // and one made here is seen there, so neither renews what the other already has.
            val (now, renewal) = answering.withLock {
                val now = tokens.value
                if (now != token) {
                    now to null
                } else {
                    val renewal = tryRefresh()
                    renewal.first?.let { if (!closing) tokens.value = it }
                    now to renewal
                }
            }
            if (renewal == null) {
                // The token is no longer the one asked about: the stream was refused with it too, and `refresh` renewed it
                // meanwhile. That token is the just-issued one, and is not renewed again.
                token = now ?: return
                justIssued = true
                continue
            }
            if (closing) return
            val (renewed, failure) = renewal
            if (renewed == null) {
                unrenewed(failure)
                return
            }
            token = renewed
            justIssued = true
        }
    }

    /** End the session: it renews nothing more, and its token and who is signed in change no more, and their readers end. Ending twice is ending once. Its client is left to whoever made it. */
    override fun close() {
        closing = true
        ended.value = true
        users.end()
        readied.complete(Unit)
        work?.cancel()
    }
}
