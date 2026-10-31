package semiont.http

import java.util.function.Consumer
import semiont.types.LocalEndpoint
import semiont.types.KbTarget
import semiont.types.HttpEndpoint
import semiont.signin.SIGN_IN_SCOPE
import semiont.signin.SCRIPT_CLIENT_ID
import semiont.signin.HeldSignIn
import semiont.errors.TransportError
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.delay
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import semiont.Timings
import semiont.errors.SignInError
import semiont.errors.SignInErrorCode
import semiont.identity.encodeUriComponent
import semiont.retry.REFRESH
import semiont.retry.RetryFacts
import semiont.retry.retryWithBackoff
import semiont.session.isTokenExpired
import semiont.signin.SignInKept
import semiont.telemetry.futureOf
import java.io.IOException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.CompletableFuture

/** The HTTP client of every request to an issuer. It keeps the JDK's default proxy selector and trust store, as a transport's does. */
internal val issuerHttp: HttpClient by lazy { HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build() }

/** What a grant issued: the access token, and the refresh token that renews it. */
public data class IssuedTokens(public val access: String, public val refresh: String)

/** An issuer's answer: its status, and its body when that was a JSON object. */
internal class Answer(val status: Int, private val body: JsonObject?) {
    /** A member of the answer that is text, when it has one. */
    fun text(name: String): String? = (body?.get(name) as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** A span of time the answer states in seconds, when it states one that can be waited. */
    fun seconds(name: String): Double? {
        val value = body?.get(name) as? JsonPrimitive ?: return null
        if (value.isString) return null
        return value.doubleOrNull?.takeIf { it >= 0 && it.isFinite() }
    }

    /** What the issuer said of a refusal: its error and description, or the status. */
    fun refusal(): String {
        val error = text("error") ?: return "HTTP $status"
        return text("error_description")?.let { "$error: $it" } ?: error
    }
}

/** A body, when it is a JSON object. */
internal fun objectIn(body: String): JsonObject? = try {
    Json.parseToJsonElement(body) as? JsonObject
} catch (_: SerializationException) {
    null
}

/** `pairs` as a form: each value as `encodeURIComponent` writes it. */
private fun form(pairs: List<Pair<String, String>>): String = pairs.joinToString("&") { (name, value) -> "$name=${encodeUriComponent(value)}" }

/** One form posted to an issuer. No answer at all, by the request's deadline or ever, is a failure with no status. */
internal suspend fun postForm(endpoint: String, pairs: List<Pair<String, String>>): Answer {
    val request = HttpRequest.newBuilder(URI.create(endpoint))
        .POST(HttpRequest.BodyPublishers.ofString(form(pairs)))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .timeout(Duration.ofMillis(Timings.HTTP_REQUEST_TIMEOUT_MS))
        .build()
    val response = try {
        issuerHttp.exchange(request, HttpResponse.BodyHandlers.ofString())
    } catch (error: IOException) {
        throw SignInError(SignInErrorCode.Exchange, "The issuer did not answer: ${error.message ?: error::class.simpleName}")
    }
    return Answer(response.statusCode(), objectIn(response.body()))
}

/** The refresh grant. An issuer that does not rotate refresh tokens returns none, and the one spent stays current. */
internal suspend fun refreshAtIssuer(tokenEndpoint: String, clientId: String, refreshToken: String): IssuedTokens {
    val answer = postForm(tokenEndpoint, listOf("grant_type" to "refresh_token", "refresh_token" to refreshToken, "client_id" to clientId))
    val access = answer.text("access_token")
    if (answer.status != 200 || access == null) {
        throw SignInError(SignInErrorCode.Exchange, "The issuer refused the token request (${answer.refusal()})", answer.status)
    }
    return IssuedTokens(access, answer.text("refresh_token") ?: refreshToken)
}

/**
 * Renew a kept sign-in at its issuer, and keep what it rotated: the new access
 * token, or null when no sign-in is kept, which is an absence and not a
 * failure. `holding` is the token its holder has: the one the gateway refused,
 * or the one due. A kept token that is not it, and has not expired, was
 * renewed some other way meanwhile, and is given as it is, so no refresh token
 * another program already replaced is spent.
 *
 * What is kept is written against what is kept then
 * (specs/src/sign-in-store/README.md, Renewing it): a renewal another program
 * made while the grant was in flight stands, and its access token is the one
 * given; a sign-in signed out meanwhile is not written back, and its new token
 * is given to nobody. A renewal that fails throws `SignInError` in the issuer's
 * own words, and, when the retry budget ran out, says how many attempts it took.
 */
public suspend fun renewKept(kept: SignInKept, holding: String?): String? {
    val held = kept.held() ?: return null
    if (held.access != holding && !isTokenExpired(held.access, System.currentTimeMillis() / 1000.0)) return held.access
    var attempts = 0
    val tokens = try {
        retryWithBackoff(Timings.REFRESH_RETRY, { REFRESH.retryable(RetryFacts(status = (it as? SignInError)?.status, method = "POST")) }) {
            attempts += 1
            refreshAtIssuer(held.tokenEndpoint, held.clientId, held.refresh)
        }
    } catch (error: SignInError) {
        // One attempt: the issuer answered, and its answer was final.
        if (attempts <= 1) throw error
        throw SignInError(SignInErrorCode.Exchange, "The session could not be renewed after $attempts attempts: ${error.message}", error.status)
    }
    return kept.renewed(held, tokens.access, tokens.refresh)
}

/** `renewKept`, for Java. */
public fun renewKeptFuture(kept: SignInKept, holding: String?): CompletableFuture<String?> =
    CoroutineScope(Dispatchers.Default).futureOf { renewKept(kept, holding) }

/** RFC 8628 §3.5's grant type, which the token endpoint is asked under while a person approves the code. */
private const val DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

/**
 * An issuer, and the endpoints of it a client uses: where a person is sent to
 * sign in, where tokens are asked for, and, when the issuer has them, where a
 * device is authorized and a refresh token revoked. Kept with a sign-in under
 * way, as every SDK keeps it.
 */
@Serializable
public data class IssuerEndpoints(
    public val issuer: String,
    public val authorization: String,
    public val token: String,
    public val device: String? = null,
    public val revocation: String? = null,
)

/** What a person is shown to approve a sign-in from wherever they have a browser. */
public data class DeviceCode(
    public val userCode: String,
    public val verificationUri: String,
    public val verificationUriComplete: String?,
    /** How long the code is good for, in seconds. */
    public val expiresIn: Double,
)

/** An issuer that issued no refresh token: a session it began could not outlive its first access token. */
internal fun noRefreshToken(): SignInError =
    SignInError(SignInErrorCode.Exchange, "The issuer returned no refresh token: the session could not outlive its first access token")

private fun noIssuer() = SignInError(SignInErrorCode.NoIssuer, "The knowledge base trusts no external issuer")

private fun expired() = SignInError(SignInErrorCode.Expired, "The code expired before it was approved")

/** Ask the knowledge base at `baseUrl` which issuer it trusts, and the issuer where its endpoints are. */
internal suspend fun discoverIssuer(baseUrl: String): IssuerEndpoints {
    // Its resource metadata is public: asked with no token, by a transport that opens no stream.
    val metadata = HttpTransport(baseUrl, MutableStateFlow(null), emptyList()).use { asking ->
        try {
            asking.getProtectedResourceMetadata()
        } catch (error: TransportError) {
            if (error.status == 404) throw noIssuer()
            throw SignInError(SignInErrorCode.Discovery, "The knowledge base did not answer its resource metadata: ${error.message}", error.status)
        }
    }
    val issuer = metadata.authorizationServers.firstOrNull() ?: throw noIssuer()
    val url = "${issuer.trimEnd('/')}/.well-known/openid-configuration"
    val request = HttpRequest.newBuilder(URI.create(url)).GET().header("Accept", "application/json")
        .timeout(Duration.ofMillis(Timings.HTTP_REQUEST_TIMEOUT_MS)).build()
    val response = try {
        issuerHttp.exchange(request, HttpResponse.BodyHandlers.ofString())
    } catch (error: IOException) {
        throw SignInError(SignInErrorCode.Discovery, "Issuer $issuer: discovery was not answered: ${error.message ?: error::class.simpleName}")
    }
    val status = response.statusCode()
    if (status !in 200..299) throw SignInError(SignInErrorCode.Discovery, "Issuer $issuer: discovery answered HTTP $status", status)
    val document = Answer(status, objectIn(response.body()))
    val authorization = document.text("authorization_endpoint")
    val token = document.text("token_endpoint")
    if (document.text("issuer") != issuer || authorization == null || token == null) {
        throw SignInError(SignInErrorCode.Discovery, "Issuer $issuer: its discovery document is not an OpenID configuration for it", status)
    }
    return IssuerEndpoints(issuer, authorization, token, document.text("device_authorization_endpoint"), document.text("revocation_endpoint"))
}

/** RFC 7009. The issuer answers 200 for a token it has already forgotten, so revoking twice is revoking once. */
internal suspend fun revokeAtIssuer(revocationEndpoint: String, clientId: String, refreshToken: String) {
    val answer = postForm(revocationEndpoint, listOf("token" to refreshToken, "token_type_hint" to "refresh_token", "client_id" to clientId))
    if (answer.status != 200) throw SignInError(SignInErrorCode.Exchange, "The issuer refused the revocation (HTTP ${answer.status})", answer.status)
}

/**
 * Sign in as a person from a process with no browser (RFC 8628): the issuer
 * the knowledge base at `baseUrl` trusts mints a code, `onCode` shows the
 * person where to approve it, and the token endpoint is asked at the issuer's
 * interval until the tokens arrive. Cancelling it abandons the sign-in.
 */
internal suspend fun signInWithDeviceGrant(baseUrl: String, onCode: (DeviceCode) -> Unit): Pair<IssuerEndpoints, IssuedTokens> {
    val issuer = discoverIssuer(baseUrl)
    val device = issuer.device ?: throw SignInError(
        SignInErrorCode.Discovery,
        "Issuer ${issuer.issuer} offers no device authorization endpoint: the device grant needs one enabled for client $SCRIPT_CLIENT_ID",
    )
    val minted = postForm(device, listOf("client_id" to SCRIPT_CLIENT_ID, "scope" to SIGN_IN_SCOPE))
    val deviceCode = minted.text("device_code")
    val userCode = minted.text("user_code")
    val verificationUri = minted.text("verification_uri")
    val expiresIn = minted.seconds("expires_in")
    if (minted.status != 200 || deviceCode == null || userCode == null || verificationUri == null || expiresIn == null) {
        throw SignInError(SignInErrorCode.Exchange, "The issuer refused the device authorization request (${minted.refusal()})", minted.status)
    }
    onCode(DeviceCode(userCode, verificationUri, minted.text("verification_uri_complete"), expiresIn))
    var interval = maxOf(minted.seconds("interval") ?: Timings.DEVICE_POLL_MS / 1000.0, Timings.DEVICE_POLL_FLOOR_MS / 1000.0)
    val deadline = System.nanoTime() + (expiresIn * 1e9).toLong()
    while (true) {
        delay((interval * 1000).toLong())
        if (System.nanoTime() > deadline) throw expired()
        val answer = postForm(issuer.token, listOf("grant_type" to DEVICE_GRANT, "device_code" to deviceCode, "client_id" to SCRIPT_CLIENT_ID))
        val access = answer.text("access_token")
        if (answer.status == 200 && access != null) {
            val refresh = answer.text("refresh_token")
                ?: throw noRefreshToken()
            return issuer to IssuedTokens(access, refresh)
        }
        when (answer.text("error")) {
            "authorization_pending" -> Unit
            "slow_down" -> interval += Timings.DEVICE_SLOW_DOWN_MS / 1000.0
            "access_denied" -> throw SignInError(SignInErrorCode.Denied, "The sign-in was denied at the issuer", answer.status)
            "expired_token" -> throw expired()
            else -> throw SignInError(SignInErrorCode.Exchange, "The issuer refused the token request (${answer.refusal()})", answer.status)
        }
    }
}

/**
 * Sign in as a person from a process with no browser, and keep the sign-in in
 * `kept`: the issuer the knowledge base `kb` trusts mints a code, `onCode`
 * shows the person where to approve it, and the tokens come back here; no
 * password passes through this process. Throws `SignInError` when the person
 * is not signed in, and (`discovery`) for a knowledge base that is not reached
 * over HTTP or whose host is no host's name.
 */
public suspend fun signInDevice(kb: KbTarget, kept: SignInKept, onCode: (DeviceCode) -> Unit) {
    val endpoint = kb.endpoint as? HttpEndpoint
        ?: throw SignInError(SignInErrorCode.Discovery, "The device grant needs an HTTP endpoint; this knowledge base's is \"${(kb.endpoint as LocalEndpoint).kind.value}\"")
    val baseUrl = try {
        gatewayUrl(endpoint)
    } catch (invalid: IllegalArgumentException) {
        throw SignInError(SignInErrorCode.Discovery, invalid.message ?: "Invalid KB hostname")
    }
    val (issuer, tokens) = signInWithDeviceGrant(baseUrl, onCode)
    kept.keep(HeldSignIn(tokens.access, tokens.refresh, SCRIPT_CLIENT_ID, issuer.token, issuer.revocation))
}

/** `signInDevice`, for Java. */
public fun signInDeviceFuture(kb: KbTarget, kept: SignInKept, onCode: Consumer<DeviceCode>): CompletableFuture<Unit> =
    CoroutineScope(Dispatchers.Default).futureOf { signInDevice(kb, kept, onCode::accept) }

/**
 * End the sign-in `kept` holds: it is revoked at its issuer, when the issuer
 * says where, and kept no more. It is forgotten whatever the issuer answers:
 * a person who signs out is signed out here, and an issuer that could not be
 * told forgets the token when it expires.
 */
public suspend fun signOut(kept: SignInKept) {
    val held = kept.held() ?: return
    try {
        held.revocationEndpoint?.let { endpoint ->
            try {
                revokeAtIssuer(endpoint, held.clientId, held.refresh)
            } catch (_: SignInError) {
                // Best effort: one that could not be told forgets it when it expires.
            }
        }
    } finally {
        kept.forget()
    }
}

/** `signOut`, for Java. */
public fun signOutFuture(kept: SignInKept): CompletableFuture<Unit> = CoroutineScope(Dispatchers.Default).futureOf { signOut(kept) }
