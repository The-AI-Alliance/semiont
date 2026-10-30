package semiont.signin

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import semiont.telemetry.futureOf
import java.util.concurrent.CompletableFuture

/**
 * What is kept of a sign-in: the tokens an issuer issued, the client they
 * were issued to, and the issuer's endpoints a renewal and a sign-out need,
 * learned once at sign-in so no session asks again.
 */
public data class HeldSignIn(
    public val access: String,
    public val refresh: String,
    public val clientId: String,
    public val tokenEndpoint: String,
    public val revocationEndpoint: String?,
)

/** Where one knowledge base's sign-in is kept. Each suspending member has its twin for Java, which returns a future. */
public interface SignInKept {
    /** The sign-in as it is kept now, when there is one. */
    public suspend fun held(): HeldSignIn?

    /** Keep a sign-in, in place of whatever was kept. */
    public suspend fun keep(signIn: HeldSignIn)

    /**
     * Keep the tokens a renewal of `read` issued, against what is kept now:
     * the access token kept then. When what is kept no longer holds `read`'s
     * tokens, it was renewed some other way meanwhile: that stands, and its
     * access token is the one given. Null when nothing is kept: a sign-in that
     * was signed out, or ended, while it was being renewed is gone, and is not
     * written back.
     */
    public suspend fun renewed(read: HeldSignIn, access: String, refresh: String): String?

    /** Keep the sign-in no more. */
    public suspend fun forget()

    /** `held`, for Java. */
    public fun heldFuture(): CompletableFuture<HeldSignIn?> = CoroutineScope(Dispatchers.Default).futureOf { held() }

    /** `keep`, for Java. */
    public fun keepFuture(signIn: HeldSignIn): CompletableFuture<Unit> = CoroutineScope(Dispatchers.Default).futureOf { keep(signIn) }

    /** `renewed`, for Java. */
    public fun renewedFuture(read: HeldSignIn, access: String, refresh: String): CompletableFuture<String?> =
        CoroutineScope(Dispatchers.Default).futureOf { renewed(read, access, refresh) }

    /** `forget`, for Java. */
    public fun forgetFuture(): CompletableFuture<Unit> = CoroutineScope(Dispatchers.Default).futureOf { forget() }
}

/** A sign-in kept for as long as the process lives, and no longer. */
public class MemorySignIn(signIn: HeldSignIn? = null) : SignInKept {
    private var signIn: HeldSignIn? = signIn

    override suspend fun held(): HeldSignIn? = synchronized(this) { signIn }

    override suspend fun keep(signIn: HeldSignIn): Unit = synchronized(this) { this.signIn = signIn }

    override suspend fun renewed(read: HeldSignIn, access: String, refresh: String): String? = synchronized(this) {
        val kept = signIn ?: return null
        if (kept.access != read.access || kept.refresh != read.refresh) return kept.access
        signIn = kept.copy(access = access, refresh = refresh)
        access
    }

    override suspend fun forget(): Unit = synchronized(this) { signIn = null }
}
