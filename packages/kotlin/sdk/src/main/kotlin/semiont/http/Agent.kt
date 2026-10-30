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
import semiont.types.AgentTokenRequest
import semiont.types.AgentTokenResponse
import semiont.types.wireJson
import java.io.IOException
import java.net.URI
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
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

/** The client-credentials grant's form for `credential`. */
private fun proof(credential: Credential): List<Pair<String, String>> = when (credential) {
    is SecretCredential -> listOf("grant_type" to "client_credentials", "client_id" to credential.clientId, "client_secret" to credential.clientSecret)
}

/**
 * A service account's token, fetched on first use and renewed when it is due:
 * it is kept until it is due for renewal by the schedule every Semiont client
 * keeps, half its lifetime before it expires and at most
 * `refreshBeforeExpMs`. A service reaches another as itself with this token.
 * A failure names the issuer and the client, and never the secret.
 */
public class ServiceToken(private val credential: Credential) {
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
            issuerHttp.exchange(request, HttpResponse.BodyHandlers.ofString())
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

    /**
     * The `Authorization` header's value: the account's token, renewed when it
     * is due. Its own `exp` and `iat` say how long it lives, or failing those
     * the grant's `expires_in`; a token that says neither is not kept.
     */
    public suspend fun authorization(): String = asking.withLock {
        held?.let { (token, until) -> if (System.nanoTime() < until) return@withLock "Bearer $token" }
        val issuer = credential.issuer
        val clientId = credential.clientId
        val endpoint = endpoint()
        val answer = try {
            postForm(endpoint, proof(credential))
        } catch (_: SignInError) {
            throw SignInError(SignInErrorCode.Exchange, "Client-credentials grant for $clientId at $issuer got no answer")
        }
        // The status, never the body: an error body can echo the secret.
        if (answer.status !in 200..299) throw SignInError(SignInErrorCode.Exchange, "Client-credentials grant for $clientId at $issuer failed (HTTP ${answer.status})", answer.status)
        val token = answer.text("access_token") ?: throw SignInError(SignInErrorCode.Exchange, "Token endpoint for $issuer returned no `access_token`", answer.status)
        val lifetime = answer.seconds("expires_in")
        // Used until it is due for renewal, and never past its expiry.
        val renewIn = refreshDelay(token, System.currentTimeMillis() / 1000.0) ?: lifetime?.let { renewalDelay(it, it) }
        held = renewIn?.let { token to System.nanoTime() + ((if (lifetime == null) it else minOf(it, lifetime)) * 1e9).toLong() }
        "Bearer $token"
    }

    /** `authorization`, for Java. */
    public fun authorizationFuture(): CompletableFuture<String> = CoroutineScope(Dispatchers.Default).futureOf { authorization() }
}

/** Whether a renewal that failed this way is worth another attempt. A refused credential is not, whatever its status: the same token gets the same answer. */
private fun transient(error: SemiontError): Boolean {
    if (error is TransportError && error.reason == TransportErrorCode.Unauthorized) return false
    val status = (error as? TransportError)?.status ?: (error as? SignInError)?.status
    return REFRESH.retryable(RetryFacts(status = status, method = "POST"))
}

/**
 * The token of the software agent `(provider, model)` at the gateway at
 * `gateway`: a service account's token exchanged at `POST /api/tokens/agent`
 * for the token of the agent that names the work it does. A transport is given
 * `token` as its token and this as its refresher.
 *
 * It is not a session. A person whose token cannot be renewed is signed out;
 * an agent whose renewal fails keeps the token it has and tries again, so a
 * process holding a token that still works does not stop over one bad round
 * trip. `signIn` signs it in, and it is kept signed in until `close`.
 */
public class AgentToken(gateway: String, provider: String, model: String, private val service: ServiceToken) : TokenRefresher, AutoCloseable {
    /** The gateway the agent signs in at. */
    public val gateway: String = gateway.trimEnd('/')
    private val agent = AgentTokenRequest(provider = provider, model = model)
    private val current = MutableStateFlow<String?>(null)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var keeping: Job? = null
    private var signedInAs: UserId? = null

    /** The agent token: the current one, and each one after it. */
    public val token: StateFlow<String?> = current.asStateFlow()

    /**
     * The agent's DID, as the gateway minted it under the knowledge base's own
     * domain, carried as it came. It is the sign-in's answer, so an agent that
     * is not signed in has none, and asking for it throws.
     */
    @get:JvmExposeBoxed
    public val did: UserId get() = signedInAs ?: throw IllegalStateException("the agent is not signed in: call signIn first")

    /**
     * Sign the agent in, and keep it signed in until `close`. Throws
     * `SignInError` when its service account could not sign in, and
     * `TransportError` when the gateway did not make the exchange.
     */
    public suspend fun signIn(): AgentToken {
        synchronized(this) { check(keeping == null && scope.coroutineContext[Job]?.isActive == true) { "an agent is signed in once" } }
        val signedIn = exchange()
        signedInAs = signedIn.did
        current.value = signedIn.token
        synchronized(this) { keeping = scope.launch { renewWhenDue(current) { renewWithinBudget() } } }
        return this
    }

    /** `signIn`, for Java. */
    public fun signInFuture(): CompletableFuture<AgentToken> = CoroutineScope(Dispatchers.Default).futureOf { signIn() }

    /** The gateway refused the token: exchange again. The new token, or null when the exchange failed. */
    override suspend fun refresh(refused: String?): String? = try {
        renew()
    } catch (_: SemiontError) {
        null
    }

    private suspend fun renew(): String = exchange().token.also { current.value = it }

    /** A due renewal: tried again inside the renewal budget when its failure is transient; spent or refused, the token is left as it is. */
    private suspend fun renewWithinBudget() {
        try {
            retryWithBackoff(Timings.REFRESH_RETRY, ::transient) { renew() }
        } catch (_: SemiontError) {
            // The next renewal is due a floor later.
        }
    }

    /** One exchange: the service account's token for the agent's, and the DID the gateway names the agent by. */
    private suspend fun exchange(): AgentTokenResponse {
        val url = "$gateway/api/tokens/agent"
        val request = HttpRequest.newBuilder(URI.create(url))
            .POST(HttpRequest.BodyPublishers.ofString(wireJson.encodeToString(AgentTokenRequest.serializer(), agent)))
            .header("Authorization", service.authorization())
            .header("Content-Type", "application/json")
            .timeout(Duration.ofMillis(Timings.HTTP_REQUEST_TIMEOUT_MS))
            .build()
        val response = try {
            issuerHttp.exchange(request, HttpResponse.BodyHandlers.ofByteArray())
        } catch (error: IOException) {
            throw TransportError.withoutResponse("$url got no answer: ${error.message ?: error::class.simpleName}")
        }
        val status = response.statusCode()
        if (status !in 200..299) {
            throw refusal("the gateway refused the agent token exchange (HTTP $status)", status, response.body(), retryAfterMs(response.headers().firstValue("retry-after").orElse(null)))
        }
        return try {
            wireJson.decodeFromString(AgentTokenResponse.serializer(), response.body().toString(Charsets.UTF_8))
        } catch (_: IllegalArgumentException) {
            // What it lacks, and none of what it holds: an answer can be a token.
            throw TransportError(TransportErrorCode.Error, "$url did not answer an agent token", status)
        }
    }

    /** Sign the agent out of this process: its renewals stop. Closing twice is closing once. */
    override fun close(): Unit = scope.cancel()
}
