package semiont.http

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
private val issuerHttp: HttpClient by lazy { HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build() }

/** What a grant issued. */
internal class IssuedTokens(val access: String, val refresh: String)

/** An issuer's answer: its status, and its body when that was a JSON object. */
internal class Answer(val status: Int, private val body: JsonObject?) {
    /** A member of the answer that is text, when it has one. */
    fun text(name: String): String? = (body?.get(name) as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** What the issuer said of a refusal: its error and description, or the status. */
    fun refusal(): String {
        val error = text("error") ?: return "HTTP $status"
        return text("error_description")?.let { "$error: $it" } ?: error
    }
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
    val body = try {
        Json.parseToJsonElement(response.body()) as? JsonObject
    } catch (_: SerializationException) {
        null
    }
    return Answer(response.statusCode(), body)
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
