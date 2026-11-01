package semiont.http

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.Serializable
import semiont.errors.SignInError
import semiont.errors.SignInErrorCode
import semiont.identity.encodeUriComponent
import semiont.registry.PENDING_AUTHORIZATION_KEY
import semiont.signin.BROWSER_CLIENT_ID
import semiont.signin.SIGN_IN_SCOPE
import semiont.storage.SessionStorage
import semiont.telemetry.futureOf
import semiont.types.HttpEndpoint
import semiont.types.wireJson
import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder
import java.net.http.HttpClient
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.CompletableFuture

private val base64Url = Base64.getUrlEncoder().withoutPadding()

private val random = SecureRandom()

/** RFC 7636 §4.2: BASE64URL(SHA-256(verifier)). */
public fun codeChallenge(verifier: String): String = base64Url.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))

/**
 * What a sign-in remembers across the trip to the issuer and back: the
 * verifier and the state the response must match, where the person was
 * connecting, what they believed they were connecting to, and the issuer's
 * endpoints, so its completion asks nothing twice. Kept as every SDK keeps it,
 * so a sign-in one began is one another completes.
 */
@Serializable
public data class PendingAuthorization(
    public val state: String,
    public val verifier: String,
    public val redirectUri: String,
    public val target: HttpEndpoint,
    public val issuer: IssuerEndpoints,
    /** The registered knowledge base being signed in to again; null when it is none. */
    public val kbId: String? = null,
    /** What the person believed they clicked, checked afterwards and never assumed; null when they named nothing. */
    public val expectedDid: String? = null,
    public val expectedName: String? = null,
)

/** What a sign-in by a page redirect begins from. */
public data class BeginAuthorizationOptions @JvmOverloads constructor(
    public val target: HttpEndpoint,
    /** Where the issuer sends the person back to. The issuer accepts only an address its registration of the client lists. */
    public val redirectUri: String,
    /** The registered knowledge base being signed in to again; null when it is none. */
    public val kbId: String? = null,
    /** What the person believed they clicked; null when they named nothing. */
    public val expectedDid: String? = null,
    public val expectedName: String? = null,
)

/** `size` random bytes, as base64url. */
private fun randomUrlSafe(size: Int): String = base64Url.encodeToString(ByteArray(size).also(random::nextBytes))

private fun queryOf(pairs: List<Pair<String, String>>): String = pairs.joinToString("&") { (name, value) -> "$name=${encodeUriComponent(value)}" }

/**
 * Begin the authorization-code grant: find the issuer the target trusts,
 * remember the pending sign-in in `pending`, and give the address to send the
 * person to. The target and its issuer are asked with `http`. Throws
 * `SignInError` (`discovery`) for a target whose host is no host's name,
 * before anything is asked or remembered, and as finding the issuer does.
 */
public suspend fun beginAuthorization(options: BeginAuthorizationOptions, pending: SessionStorage, http: HttpClient = ownHttp): String {
    val baseUrl = try {
        gatewayUrl(options.target)
    } catch (invalid: IllegalArgumentException) {
        throw SignInError(SignInErrorCode.Discovery, invalid.message ?: "Invalid KB hostname")
    }
    val issuer = discoverIssuer(baseUrl, http)
    val record = PendingAuthorization(
        state = randomUrlSafe(24),
        verifier = randomUrlSafe(48),
        redirectUri = options.redirectUri,
        target = options.target,
        issuer = issuer,
        kbId = options.kbId,
        expectedDid = options.expectedDid,
        expectedName = options.expectedName,
    )
    pending.set(PENDING_AUTHORIZATION_KEY, wireJson.encodeToString(PendingAuthorization.serializer(), record))
    val asked = queryOf(
        listOf(
            "response_type" to "code",
            "client_id" to BROWSER_CLIENT_ID,
            "redirect_uri" to record.redirectUri,
            "scope" to SIGN_IN_SCOPE,
            "state" to record.state,
            "code_challenge" to codeChallenge(record.verifier),
            "code_challenge_method" to "S256",
        ),
    )
    val joiner = if ('?' in issuer.authorization) "&" else "?"
    return "${issuer.authorization}$joiner$asked"
}

/** `beginAuthorization`, for Java. */
@JvmOverloads
public fun beginAuthorizationFuture(options: BeginAuthorizationOptions, pending: SessionStorage, http: HttpClient = ownHttp): CompletableFuture<String> =
    CoroutineScope(Dispatchers.Default).futureOf { beginAuthorization(options, pending, http) }

/** The pending sign-in, taken out of `pending` as one step; null when none is there, or what is there is not one. */
private fun taken(pending: SessionStorage): PendingAuthorization? {
    var took: String? = null
    pending.update(PENDING_AUTHORIZATION_KEY) { stored ->
        took = stored
        null
    }
    return took?.let {
        try {
            wireJson.decodeFromString(PendingAuthorization.serializer(), it)
        } catch (_: IllegalArgumentException) {
            null
        }
    }
}

/** What an address asks, each name with every value it is given. */
private fun said(query: String?): Map<String, List<String>> =
    query.orEmpty().split('&').filter { it.isNotEmpty() }.map { pair ->
        val (name, value) = pair.split('=', limit = 2).let { it[0] to it.getOrElse(1) { "" } }
        URLDecoder.decode(name, Charsets.UTF_8) to URLDecoder.decode(value, Charsets.UTF_8)
    }.groupBy({ it.first }, { it.second })

/**
 * Finish the authorization-code grant from the address the issuer sent the
 * person back to, and give the pending sign-in it completed and what the
 * issuer issued. The pending sign-in is taken before anything else happens: a
 * code is good once, and a callback that is replayed finds nothing to
 * complete. Throws `SignInError`: `no-pending` when no sign-in is pending
 * here, `denied` when the person refused it, `state` for a response that is
 * not the pending sign-in's, and `exchange` when the issuer refused the code
 * or answered without what was asked for. The issuer is asked with `http`.
 */
public suspend fun completeAuthorization(callbackUrl: String, pending: SessionStorage, http: HttpClient = ownHttp): Pair<PendingAuthorization, IssuedTokens> {
    val record = taken(pending) ?: throw SignInError(SignInErrorCode.NoPending, "No sign-in is pending here")
    val callback = try {
        URI(callbackUrl)
    } catch (invalid: URISyntaxException) {
        throw SignInError(SignInErrorCode.Exchange, "The sign-in response is not a URL: ${invalid.message}")
    }
    if (callback.scheme == null) throw SignInError(SignInErrorCode.Exchange, "The sign-in response is not a URL: relative URL without a base")
    val response = said(callback.rawQuery)
    response["error"]?.let { failure ->
        val code = if (failure.first() == "access_denied") SignInErrorCode.Denied else SignInErrorCode.Exchange
        throw SignInError(code, response["error_description"]?.first() ?: failure.first())
    }
    if (response["state"]?.firstOrNull() != record.state) throw SignInError(SignInErrorCode.State, "The sign-in response does not belong to the pending sign-in")
    val code = response["code"]?.firstOrNull() ?: throw SignInError(SignInErrorCode.Exchange, "The sign-in response carries no authorization code")
    val answer = postForm(
        record.issuer.token,
        listOf(
            "grant_type" to "authorization_code",
            "code" to code,
            "redirect_uri" to record.redirectUri,
            "client_id" to BROWSER_CLIENT_ID,
            "code_verifier" to record.verifier,
        ),
        http,
    )
    val access = answer.text("access_token")
    if (answer.status != 200 || access == null) {
        throw SignInError(SignInErrorCode.Exchange, "The issuer refused the token request (${answer.refusal()})", answer.status)
    }
    val refresh = answer.text("refresh_token") ?: throw noRefreshToken()
    return record to IssuedTokens(access, refresh)
}

/** `completeAuthorization`, for Java. */
@JvmOverloads
public fun completeAuthorizationFuture(callbackUrl: String, pending: SessionStorage, http: HttpClient = ownHttp): CompletableFuture<Pair<PendingAuthorization, IssuedTokens>> =
    CoroutineScope(Dispatchers.Default).futureOf { completeAuthorization(callbackUrl, pending, http) }
