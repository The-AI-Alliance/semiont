package semiont.session

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
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
import semiont.retry.equalJitter
import semiont.signin.HeldSignIn
import semiont.signin.SignInKept
import semiont.telemetry.futureOf
import semiont.transport.Broadcast
import semiont.transport.ConnectionState
import semiont.transport.Events
import semiont.transport.Variable
import semiont.transport.Watched
import semiont.types.KbTarget
import semiont.types.UserResponse
import java.util.UUID
import java.util.concurrent.CompletableFuture
import kotlin.random.Random

/** Why a session ended: its issuer refused to renew its token (`EXPIRED`), or the gateway refused a token its issuer had just issued (`REFUSED`). */
public enum class SessionEndReason(
    /** The reason as every SDK spells it. */
    public val wire: String,
) {
    EXPIRED("expired"),
    REFUSED("refused"),
}

private const val JUST_ISSUED_AND_REFUSED = "The gateway refused a token its issuer had just issued"

/** Why a renewal gave no token, for whoever reads the error: what the renewal failed with, in its own words. */
private fun notRenewed(failure: Exception?): String = when (failure) {
    null -> "Token refresh failed"
    is SemiontError -> "Token refresh failed: ${failure.message}"
    else -> "Token refresh failed: $failure"
}

/** Why a session failed, and why its kept sign-in could not be forgotten: what its storage said, in its own words, as `notRenewed` says a renewal's failure. */
private fun notForgotten(why: String, unforgotten: Exception): String = when (unforgotten) {
    is SemiontError -> "$why; and the sign-in could not be forgotten: ${unforgotten.message}"
    else -> "$why; and the sign-in could not be forgotten: $unforgotten"
}

/**
 * Whether a renewal failed because the issuer refused it: an answer the `refresh` rule does not try again. No answer,
 * one it tries again until the budget is spent, and a sign-in that could not be read to renew with are no refusal.
 */
private fun refused(failure: Exception): Boolean =
    failure is SignInError && failure.reason == SignInErrorCode.Exchange && failure.status != null &&
        !REFRESH.retryable(RetryFacts(status = failure.status, method = "POST", keyed = false))

private fun now(): Double = System.currentTimeMillis() / 1000.0

/**
 * A session with one knowledge base: the token its client's transport sends
 * and who is signed in, the token renewed before it expires and when the
 * gateway refuses it (protocol/specs/src/session/cases.json). It writes its token and
 * who is signed in, so it ends them; it only uses its client, so it never ends
 * it, and whoever made the client and the session ends both.
 *
 * At its start it asks the gateway who the kept token is. A token the gateway
 * refuses is renewed once and asked about once more; a token its issuer had
 * just issued and the gateway refuses is final. So the gateway is asked at most
 * twice and the issuer at most once. Whenever a token is renewed, what is kept
 * is forgotten only when the issuer refuses: a renewal that got no answer leaves
 * the session no usable token and keeps what is kept, and the next refusal
 * renews again, and so does the session on its own, on the reconnect backoff,
 * its jitter drawn from `random`. Every renewal (`renew`) is handed the token
 * it renews. What went wrong the session says once, on its errors; it takes
 * no callback for it. A kept sign-in that cannot be forgotten is said with why
 * it had to be: as `session.refresh-exhausted` when the issuer refused its
 * renewal at the start, and under its ending's code when the session ends,
 * each with what its storage said.
 */
public class SemiontSession internal constructor(
    /** The knowledge base the session is with: where it is reached, and `id`, the key its credentials are kept under. */
    public val kb: KbTarget,
    /** The client whose transport sends the session's token. */
    public val client: SemiontClient,
    private val tokens: MutableStateFlow<String?>,
    private val kept: SignInKept,
    private val renew: (suspend (String?) -> String?)?,
    private val validate: (suspend (String) -> UserResponse)?,
    private val onAuthFailed: ((SessionEndReason) -> Unit)?,
    private val random: Random,
) : StateUnit {
    /** Which live session this is: a new one for the same knowledge base has another. */
    public val id: String = "session-${UUID.randomUUID()}"

    private val users = Variable<UserResponse?>(null)

    // Holds once the session has ended: its token's readers end with it.
    private val ended = MutableStateFlow(false)
    private val readied = CompletableDeferred<Unit>()

    // Held while a refusal is being answered, and while a token whose wait ran out is renewed, so that the refusals and
    // the waits that run out during it are answered by it: each finds the token it was for replaced.
    private val answering = Mutex()

    // Holds while a renewal that got no answer is owed another attempt.
    private val unanswered = MutableStateFlow(false)

    // What the session says, its own errors and its transport's failures in the order met: the latest `errorsKeptForFirstReaderCount` kept for its first reader until someone reads it.
    private val saying = Broadcast<SemiontError>(keptForFirst = Timings.ERRORS_KEPT_FOR_FIRST_READER_COUNT)

    // The transport's failures, from when the session is made until its errors end.
    private val carried = client.transport.failures()

    init {
        // Unconfined, so each failure is said within the transport's telling of it, before whatever the session says next.
        // No child of the session's work or of its client's: it carries what the client's closing flush meets, and ends with the errors.
        CoroutineScope(Dispatchers.Unconfined).launch(start = CoroutineStart.UNDISPATCHED) { carried.collect { saying.deliver(it) } }
    }

    // The token the session held last, remembered as it gives it up: what a renewal is handed while it holds none.
    @Volatile
    private var lastHeld: String? = null

    @Volatile
    private var closing = false
    private var work: CoroutineScope? = null

    /** The token the transport sends: the present one, and each after it, until the session ends. */
    public val token: Watched<String?> = Watched(tokens, ended)

    /** Who is signed in, once the gateway has said, until the session ends. */
    public val user: Watched<UserResponse?> = users.reading()

    /** The state of the client's connection. */
    public val streamState: Watched<ConnectionState> get() = client.transport.state

    /**
     * What went wrong, each said once: what the session says of its own (a
     * `SessionError`: `session.auth-failed`, `session.refresh-exhausted`,
     * `session.credential-refused`, `session.keep-failed`,
     * `session.save-refused`), and the failures its client's transport meets,
     * a refusal for want of a valid token among them, which the transport
     * that met it renews: one stream, in the order they were met. Of what the
     * session said, and what its transport met, before anyone read them, the
     * latest `errorsKeptForFirstReaderCount` are kept for the first reader, in
     * that order, the oldest dropped beyond that. A later reader hears from when it
     * reads. They end when the session ends, once the writes its client has
     * begun are made or refused: whoever ends both closes the client first,
     * so what its closing flush meets is said before they end. What the
     * client meets once its session has ended is said nowhere.
     */
    public fun errors(): Events<SemiontError> = saying.listen()

    /** Say `error` on the session's errors, from the coroutine that met it. */
    internal fun say(error: SessionError) {
        saying.deliver(error)
    }

    /** When the token the session holds expires, in seconds since the epoch. */
    public fun expiresAt(): Double? = tokens.value?.let(::tokenExpiry)

    /** Wait until the session has done what it does at its start. It returns whatever that came to. */
    public suspend fun ready(): Unit = readied.await()

    /** `ready`, for Java. */
    public fun readyFuture(): CompletableFuture<Unit> = client.links.future { ready() }

    /**
     * Start the session: a kept token that is still good is what the transport
     * sends first, and the session's renewals and its start run on its
     * client's context, as no child of whoever starts it.
     */
    internal suspend fun start() {
        check(work == null && !closing) { "a session is started once" }
        val found = kept.held()
        // The token found is the one its renewal is handed, though it has expired and the transport is never given it.
        lastHeld = found?.access
        if (found != null && !isTokenExpired(found.access, now()) && tokens.value == null) tokens.value = found.access
        val scope = CoroutineScope(client.links.scope.coroutineContext.minusKey(Job) + SupervisorJob())
        work = scope
        scope.launch { renewWhenDue(tokens) { due -> renewDue(due) } }
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
     * The gateway refused `refused`, the token a request carried (null when it
     * carried none): renew it, and ask the gateway who the new one is. This is
     * what the session's transport calls when it is refused a token; a caller
     * that wants the token renewed passes the token the session holds. Returns
     * the token the session then holds, or null: it holds no token, and if the
     * issuer refused to renew a kept sign-in it is over. One refusal is
     * answered at a time, so refusals that arrive together cost one renewal
     * and one ask, and who the gateway says the renewed token is, is who is
     * signed in. A token the session no longer holds was answered already,
     * however late the refusal arrives: the token it holds is given, and
     * nothing is renewed or asked. A gateway that cannot be asked refuses
     * nothing: the renewed token is given. Once the session is closed, a
     * refusal is given null, whatever token it refused, and nothing is
     * renewed, and one waiting on the renewal under way is given null too:
     * the close signs nobody out, and the session takes nothing that renewal
     * brings.
     */
    public suspend fun refresh(refused: String?): String? =
        answering.withLock {
            if (closing) return@withLock null
            // The first of refusals that arrive together renews and asks; the rest find the token is no longer theirs.
            if (tokens.value != refused) return@withLock tokens.value
            // The token checked is the one handed, never one read again: a renewal made meanwhile is answered by what keeps the sign-in.
            val renewed = renewed(refused ?: lastHeld)
            if (renewed == null || validate == null) return@withLock renewed
            // While the session is starting, its start is what asks: it takes the renewed token up as the just-issued one.
            if (!readied.isCompleted) return@withLock renewed
            try {
                val user = validate.invoke(renewed)
                // Who the token the session still holds is, as the gateway said.
                if (!closing && tokens.value == renewed) users.set(user)
            } catch (refusal: SemiontError) {
                // Only a token the session still holds ends it: one replaced meanwhile is no longer the session's to be refused.
                val renewedRefused = refusal is TransportError && refusal.reason == TransportErrorCode.Unauthorized
                if (renewedRefused && !closing && tokens.value == renewed) {
                    signedOut(SessionEndReason.REFUSED, SessionErrorCode.CredentialRefused, JUST_ISSUED_AND_REFUSED)
                }
            }
            if (closing) null else tokens.value
        }

    /** `refresh`, for Java. */
    public fun refreshFuture(refused: String?): CompletableFuture<String?> = client.links.future { refresh(refused) }

    /**
     * Ask the renewal, handing it `holding`, the token it renews, as its caller
     * checked it: the one the session holds, expired or not, or, holding none,
     * the one it held last, which is the one found kept at its start or the
     * one a renewal that got no answer was for. One that could not be made and
     * one that was refused both leave the session without a token. A renewal
     * that fails otherwise than the issuer refusing it, a sign-in that cannot
     * be read to renew with among them, got no answer.
     */
    private suspend fun tryRefresh(holding: String?): Pair<String?, Exception?> {
        val renewing = renew ?: return null to null
        return try {
            renewing(holding) to null
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            null to failure
        }
    }

    /** Hold no token, remembering the one given up: the token a renewal is handed until the session holds another. */
    private fun holdNone() {
        tokens.value?.let { lastHeld = it }
        tokens.value = null
    }

    /** Renew `holding` at the issuer, with nobody asked afterwards: what the session does on its own schedule. */
    private suspend fun renewed(holding: String?): String? {
        if (closing || renew == null) return null
        val (token, failure) = tryRefresh(holding)
        if (closing) return null
        if (token != null) {
            unanswered.value = false
            tokens.value = token
            return token
        }
        holdNone()
        val unread = try {
            // A session that never had a credential cannot expire: it is signed out, which is no failure.
            if (kept.held() == null) {
                unanswered.value = false
                return null
            }
            null
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (unread: Exception) {
            // A sign-in that cannot be read is not known to be gone: a renewal that gave nothing got no answer.
            unread
        }
        unrenewed(failure ?: unread)
        return null
    }

    /**
     * Renew `due`, the token whose wait ran out, under the lock a refusal is answered under, and only while it is still
     * the token the session holds: one renewed some other way meanwhile has a wait of its own, and renews nothing here.
     */
    private suspend fun renewDue(due: String) {
        answering.withLock { if (tokens.value == due) renewed(due) }
    }

    /**
     * After a renewal that got no answer, renew again on the reconnect backoff: each wait is the equal jitter of its
     * step, the step `RECONNECT_MS` doubling to `MAX_RECONNECT_MS`. It ends when a renewal is made or refused, when a
     * token arrives some other way, and when the session ends. A renewal made while nobody has said who the session's
     * token is asks the gateway once, as the start would have.
     */
    private suspend fun renewWhenUnanswered() {
        while (true) {
            unanswered.first { it }
            var step = Timings.RECONNECT_MS
            while (unanswered.value) {
                delay(equalJitter(step, random))
                when {
                    tokens.value != null -> unanswered.value = false
                    !unanswered.value -> {}
                    users.value == null -> refresh(null)
                    else -> renewed(lastHeld)
                }
                step = minOf(2 * step, Timings.MAX_RECONNECT_MS)
            }
        }
    }

    /**
     * A renewal of what is kept gave no token, and the session holds none. The issuer's refusal, or nothing left to renew
     * with, ends the session; any other failure keeps what is kept, and says why: the next refusal renews again, and so
     * does the reconnect backoff.
     */
    private suspend fun unrenewed(failure: Exception?) {
        holdNone()
        if (failure != null && !refused(failure)) {
            unanswered.value = true
            say(SessionError(SessionErrorCode.RefreshExhausted, notRenewed(failure), kb.id))
        } else {
            signedOut(SessionEndReason.EXPIRED, SessionErrorCode.RefreshExhausted, notRenewed(failure))
        }
    }

    /**
     * The session is over: its credential is forgotten, its host is told why,
     * and so are its errors, under `code`, and why it could not be forgotten
     * when it could not. The one teardown, whichever way it ended.
     */
    private suspend fun signedOut(told: SessionEndReason, code: SessionErrorCode, why: String) {
        unanswered.value = false
        holdNone()
        users.set(null)
        val unforgotten = forget()
        onAuthFailed?.invoke(told)
        say(SessionError(code, if (unforgotten == null) why else notForgotten(why, unforgotten), kb.id))
    }

    /** Forget the kept sign-in: what its storage failed with, when it could not be forgotten; null when it was. */
    private suspend fun forget(): Exception? = try {
        kept.forget()
        null
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (unforgotten: Exception) {
        unforgotten
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
            val (renewed, failure) = tryRefresh(token)
            if (renewed == null) {
                if (failure == null || refused(failure)) {
                    // There was no session to end: the sign-in is forgotten, and nothing is said unless it could not be.
                    forget()?.let { unforgotten -> say(SessionError(SessionErrorCode.RefreshExhausted, notForgotten(notRenewed(failure), unforgotten), kb.id)) }
                } else {
                    // The issuer did not refuse it: the sign-in is kept, and renewed on the reconnect backoff or when a request is refused.
                    unanswered.value = true
                    say(SessionError(SessionErrorCode.AuthFailed, notRenewed(failure), kb.id))
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
                    say(SessionError(SessionErrorCode.AuthFailed, refusal.message, kb.id))
                    return
                }
            } catch (other: SemiontError) {
                say(SessionError(SessionErrorCode.AuthFailed, other.message, kb.id))
                return
            }
            if (closing) return
            if (justIssued) {
                signedOut(SessionEndReason.REFUSED, SessionErrorCode.CredentialRefused, JUST_ISSUED_AND_REFUSED)
                return
            }
            // Seen, and renewed, under the lock a refusal is answered under: a renewal `refresh` makes meanwhile is seen here,
            // and one made here is seen there, so neither renews what the other already has.
            val (now, renewal) = answering.withLock {
                val now = tokens.value
                if (now != token) {
                    now to null
                } else {
                    val renewal = tryRefresh(token)
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

    /**
     * End the session: it renews nothing more, and its token and who is
     * signed in change no more, and their readers end. Its errors end with it,
     * once the writes its client has begun are made or refused, so a session
     * closed after its client says what that client's closing flush met
     * first; what the client meets after is said nowhere. Ending twice is
     * ending once. Its client is left to whoever made it.
     */
    override fun close() {
        closing = true
        ended.value = true
        users.end()
        readied.complete(Unit)
        work?.cancel()
        // On the client's context, as no child of its work, which its closing has ended: at once, when no write is under way.
        CoroutineScope(client.links.scope.coroutineContext.minusKey(Job)).launch(start = CoroutineStart.UNDISPATCHED) {
            client.flushed()
            saying.close()
            carried.close()
        }
    }
}
