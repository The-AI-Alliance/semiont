@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.http

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import semiont.Timings
import semiont.errors.SemiontError
import semiont.errors.SignInError
import semiont.errors.SignInErrorCode
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.identifiers.UserId
import semiont.retry.REFRESH
import semiont.retry.RetryFacts
import semiont.retry.retryAfterMs
import semiont.retry.retryWithBackoff
import semiont.session.refreshDelay
import semiont.session.renewWhenDue
import semiont.session.renewalDelay
import semiont.telemetry.futureOf
import semiont.types.UserResponse
import semiont.types.wireJson
import java.io.IOException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.KeyFactory
import java.security.interfaces.RSAPrivateCrtKey
import java.security.spec.InvalidKeySpecException
import java.security.spec.PKCS8EncodedKeySpec
import java.time.Duration
import java.util.Base64
import java.util.concurrent.CompletableFuture

/** A service account at an issuer, by how it proves itself. */
public sealed interface Credential {
    /** The issuer the account is registered at. */
    public val issuer: String

    /** The account's client at that issuer. */
    public val clientId: String
}

/** A service account at an issuer, which proves itself with its client secret. What it says of itself never says the secret. */
public class SecretCredential(
    override val issuer: String,
    override val clientId: String,
    public val clientSecret: String,
) : Credential {
    override fun toString(): String = "SecretCredential(issuer=$issuer, clientId=$clientId)"
}

/**
 * A service account at an issuer, which proves itself with a key: each grant
 * carries an assertion signed with `privateKey`, which the issuer checks with
 * the public half registered on the client. The key never leaves the process,
 * and what the credential says of itself never says it.
 */
public class KeyCredential(
    override val issuer: String,
    override val clientId: String,
    /** The account's RSA key, which carries its public half: the assertion names the key by that half's thumbprint. */
    public val privateKey: RSAPrivateCrtKey,
) : Credential {
    override fun toString(): String = "KeyCredential(issuer=$issuer, clientId=$clientId)"

    public companion object {
        private val PEM = Regex("""-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]*)-----END PRIVATE KEY-----""")

        /**
         * The account whose key is `pem`: an RSA key in PKCS#8 PEM
         * (`-----BEGIN PRIVATE KEY-----`), as the launcher hands a worker its
         * key in `SEMIONT_OIDC_CLIENT_KEY`. Anything else throws
         * `IllegalArgumentException`, saying what it is not and nothing of
         * what it holds.
         */
        @JvmStatic
        public fun fromPem(issuer: String, clientId: String, pem: String): KeyCredential {
            val body = PEM.matchEntire(pem.trim())?.groupValues?.get(1)
                ?: throw IllegalArgumentException("the key for $clientId is not a PKCS#8 PEM, one `-----BEGIN PRIVATE KEY-----` block")
            val der = try {
                Base64.getDecoder().decode(body.filterNot(Char::isWhitespace))
            } catch (_: IllegalArgumentException) {
                throw IllegalArgumentException("the key for $clientId is not a PKCS#8 PEM: its body is not base64")
            }
            val key = try {
                KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(der))
            } catch (_: InvalidKeySpecException) {
                throw IllegalArgumentException("the key for $clientId is not an RSA private key")
            }
            require(key is RSAPrivateCrtKey) { "the key for $clientId is an RSA private key without its public half" }
            return KeyCredential(issuer, clientId, key)
        }
    }
}

/** The client-credentials grant's form for `credential` at `tokenEndpoint`: the secret itself, or an assertion signed for this grant alone. */
private fun proof(credential: Credential, tokenEndpoint: String): List<Pair<String, String>> = when (credential) {
    is SecretCredential -> listOf("grant_type" to "client_credentials", "client_id" to credential.clientId, "client_secret" to credential.clientSecret)
    is KeyCredential -> listOf(
        "grant_type" to "client_credentials",
        "client_assertion_type" to JWT_BEARER,
        "client_assertion" to clientAssertion(credential.privateKey, credential.clientId, tokenEndpoint, issuedAt = System.currentTimeMillis() / 1000, jti = freshJti()),
    )
}

/**
 * A service account's token, fetched on first use and renewed when it is due:
 * it is kept until it is due for renewal by the schedule every Semiont client
 * keeps, half its lifetime before it expires and at most
 * `refreshBeforeExpMs`. A service reaches another as itself with this token.
 * Its issuer is asked with `http`. A failure names the issuer and the client,
 * and never the secret or the key.
 */
public class ServiceToken @JvmOverloads constructor(private val credential: Credential, private val http: HttpClient = ownHttp) {
    // One grant at a time: those who ask while one is under way are given what it brings.
    private val asking = Mutex()
    private var tokenEndpoint: String? = null

    /** The token, and until when it is used, by the monotonic clock in nanoseconds. */
    private var held: Pair<String, Long>? = null

    private suspend fun endpoint(): String {
        tokenEndpoint?.let { return it }
        val issuer = credential.issuer
        val url = "${if (issuer.endsWith('/')) issuer else "$issuer/"}.well-known/openid-configuration"
        val request = HttpRequest.newBuilder(URI.create(url)).GET().timeout(Duration.ofMillis(Timings.HTTP_REQUEST_TIMEOUT_MS)).build()
        val response = try {
            http.exchange(request, HttpResponse.BodyHandlers.ofString())
        } catch (error: IOException) {
            throw SignInError(SignInErrorCode.Discovery, "OIDC discovery for $issuer got no answer: ${error.message ?: error::class.simpleName}")
        }
        val status = response.statusCode()
        if (status !in 200..299) throw SignInError(SignInErrorCode.Discovery, "OIDC discovery for $issuer failed: HTTP $status from $url", status)
        val found = Answer(status, objectIn(response.body())).text("token_endpoint")
            ?: throw SignInError(SignInErrorCode.Discovery, "OIDC discovery for $issuer returned no `token_endpoint`", status)
        tokenEndpoint = found
        return found
    }

    /** The `Authorization` header's value: the account's token, renewed when it is due. */
    public suspend fun authorization(): String = "Bearer ${token(renewed = false)}"

    /**
     * The account's token: the one held until it is due, and a new grant
     * after, or at once when `renewed`. Its own `exp` and `iat` say how long
     * it lives, or failing those the grant's `expires_in`; a token that says
     * neither is not kept.
     */
    internal suspend fun token(renewed: Boolean): String = asking.withLock {
        if (!renewed) held?.let { (token, until) -> if (System.nanoTime() < until) return@withLock token }
        val issuer = credential.issuer
        val clientId = credential.clientId
        val endpoint = endpoint()
        val answer = try {
            postForm(endpoint, proof(credential, endpoint), http)
        } catch (_: SignInError) {
            throw SignInError(SignInErrorCode.Exchange, "Client-credentials grant for $clientId at $issuer got no answer")
        }
        // The status, never the body: an error body can echo what it was sent.
        if (answer.status !in 200..299) throw SignInError(SignInErrorCode.Exchange, "Client-credentials grant for $clientId at $issuer failed (HTTP ${answer.status})", answer.status)
        val token = answer.text("access_token") ?: throw SignInError(SignInErrorCode.Exchange, "Token endpoint for $issuer returned no `access_token`", answer.status)
        val lifetime = answer.seconds("expires_in")
        // Used until it is due for renewal, and never past its expiry.
        val renewIn = refreshDelay(token, System.currentTimeMillis() / 1000.0) ?: lifetime?.let { renewalDelay(it, it) }
        held = renewIn?.let { token to System.nanoTime() + ((if (lifetime == null) it else minOf(it, lifetime)) * 1e9).toLong() }
        token
    }

    /** `authorization`, for Java. */
    public fun authorizationFuture(): CompletableFuture<String> = CoroutineScope(Dispatchers.Default).futureOf { authorization() }
}

/**
 * Whether a renewal that failed this way is worth another attempt. A renewal
 * is a grant at the issuer, whose answer is the verdict (`REFRESH`): no
 * answer, or one saying "not now", is worth another; a refused grant is not,
 * because the same credential gets the same answer.
 */
private fun transient(error: SemiontError): Boolean = REFRESH.retryable(RetryFacts(status = (error as? SignInError)?.status, method = "POST"))

/**
 * The token of the agent whose account `service` names, at the gateway at
 * `gateway`. An agent is an account, as a person is: its token is the one its
 * issuer grants the account, and the gateway names it by that account. A
 * transport is given `token` as its token and this as its refresher.
 *
 * It is not a session. A person whose token cannot be renewed is signed out;
 * an agent whose renewal fails keeps the token it has and tries again, so a
 * process holding a token that still works does not stop over one bad round
 * trip. `signIn` signs it in, and it is kept signed in until `close`. The
 * gateway is asked who the agent is with `http`; its issuer is asked with the
 * client `service` was given.
 */
public class AgentToken @JvmOverloads constructor(gateway: String, private val service: ServiceToken, private val http: HttpClient = ownHttp) : TokenRefresher, AutoCloseable {
    /** The gateway the agent signs in at. */
    public val gateway: String = gateway.trimEnd('/')
    private val current = MutableStateFlow<String?>(null)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var keeping: Job? = null
    private var signedInAs: UserId? = null

    /** The agent's token: the current one, and each one after it. */
    public val token: StateFlow<String?> = current.asStateFlow()

    /**
     * The agent's DID, as the gateway names its account under the knowledge
     * base's own domain, carried as it came. The gateway is asked once, at
     * sign-in, so an agent that is not signed in has none, and asking for it
     * throws.
     */
    @get:JvmExposeBoxed
    public val did: UserId get() = signedInAs ?: throw IllegalStateException("the agent is not signed in: call signIn first")

    /**
     * Sign the agent in, and keep it signed in until `close`. Throws
     * `SignInError` when its account could not sign in, and `TransportError`
     * when the gateway did not say who the agent is.
     */
    public suspend fun signIn(): AgentToken {
        synchronized(this) { check(keeping == null && scope.coroutineContext[Job]?.isActive == true) { "an agent is signed in once" } }
        val token = service.token(renewed = false)
        signedInAs = named(token)
        current.value = token
        synchronized(this) { keeping = scope.launch { renewWhenDue(current) { renewWithinBudget() } } }
        return this
    }

    /** `signIn`, for Java. */
    public fun signInFuture(): CompletableFuture<AgentToken> = CoroutineScope(Dispatchers.Default).futureOf { signIn() }

    /** The gateway refused the token: ask the issuer for another. The new token, or null when the issuer gave none. */
    override suspend fun refresh(refused: String?): String? = try {
        renew()
    } catch (_: SemiontError) {
        null
    }

    private suspend fun renew(): String = service.token(renewed = true).also { current.value = it }

    /** A due renewal: tried again inside the renewal budget when its failure is transient; spent or refused, the token is left as it is. */
    private suspend fun renewWithinBudget() {
        try {
            retryWithBackoff(Timings.REFRESH_RETRY, ::transient) { renew() }
        } catch (_: SemiontError) {
            // The next renewal is due a floor later.
        }
    }

    /** The DID the gateway names the bearer of `token` by: `GET /api/users/me`. */
    private suspend fun named(token: String): UserId {
        val url = "$gateway/api/users/me"
        val request = HttpRequest.newBuilder(URI.create(url))
            .GET()
            .header("Authorization", "Bearer $token")
            .timeout(Duration.ofMillis(Timings.HTTP_REQUEST_TIMEOUT_MS))
            .build()
        val response = try {
            http.exchange(request, HttpResponse.BodyHandlers.ofByteArray())
        } catch (error: IOException) {
            throw TransportError.withoutResponse("$url got no answer: ${error.message ?: error::class.simpleName}")
        }
        val status = response.statusCode()
        if (status !in 200..299) {
            throw refusal("the gateway refused the agent's token (HTTP $status)", status, response.body(), retryAfterMs(response.headers().firstValue("retry-after").orElse(null)))
        }
        return try {
            wireJson.decodeFromString(UserResponse.serializer(), response.body().toString(Charsets.UTF_8)).did
        } catch (_: IllegalArgumentException) {
            // What it lacks, and none of what it holds.
            throw TransportError(TransportErrorCode.Error, "$url did not answer who the agent is", status)
        }
    }

    /** Sign the agent out of this process: its renewals stop. Closing twice is closing once. */
    override fun close(): Unit = scope.cancel()
}
