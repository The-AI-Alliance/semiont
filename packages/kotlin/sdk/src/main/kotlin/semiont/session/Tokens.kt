package semiont.session

import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import semiont.Timings
import java.util.Base64

/** The claims of a JWT: its second segment of three, base64url without padding, UTF-8 JSON. */
private fun claims(token: String): JsonObject? {
    val segments = token.split('.')
    if (segments.size != 3) return null
    val payload = try {
        Base64.getUrlDecoder().decode(segments[1])
    } catch (_: IllegalArgumentException) {
        return null
    }
    return try {
        Json.parseToJsonElement(payload.toString(Charsets.UTF_8)) as? JsonObject
    } catch (_: SerializationException) {
        null
    }
}

/** A numeric claim, in seconds. Absent, or zero, is none. */
private fun seconds(claims: JsonObject, name: String): Double? {
    val value = claims[name] as? JsonPrimitive ?: return null
    if (value.isString) return null
    return value.doubleOrNull?.takeIf { it != 0.0 }
}

/** A claim of a token that is text, when the token carries one. */
public fun textClaim(token: String, name: String): String? = (claims(token)?.get(name) as? JsonPrimitive)?.takeIf { it.isString }?.content

/** When a token expires, by its `exp` claim, in seconds since the epoch. Null when it names no time. */
public fun tokenExpiry(token: String): Double? = claims(token)?.let { seconds(it, "exp") }

/** Whether a token is past its expiry at `now`, in seconds since the epoch. One that names no expiry is read as expired: nothing says it is still good. */
public fun isTokenExpired(token: String, now: Double): Boolean {
    val expiry = tokenExpiry(token)
    return expiry == null || expiry < now
}

/** How long to wait, in seconds, before renewing a token that lives `lifetime` in all and has `remaining` of it left. */
public fun renewalDelay(lifetime: Double, remaining: Double): Double {
    val margin = minOf(Timings.REFRESH_BEFORE_EXP_MS / 1000.0, lifetime / 2)
    return maxOf(remaining - margin, Timings.MIN_REFRESH_DELAY_MS / 1000.0)
}

/**
 * How long to wait, in seconds from `now`, before renewing `token`. Null when
 * it has no readable `exp`: nothing is scheduled. The lifetime is the one the
 * issuer chose (`exp - iat`); with no `iat`, what remains of it.
 */
public fun refreshDelay(token: String, now: Double): Double? {
    val read = claims(token) ?: return null
    val expiry = seconds(read, "exp") ?: return null
    val remaining = maxOf(expiry - now, 0.0)
    val issued = seconds(read, "iat")
    return renewalDelay(if (issued == null) remaining else maxOf(expiry - issued, 0.0), remaining)
}

/**
 * Renew a token whenever it is due, for as long as this runs: wait what
 * `refreshDelay` says of the token as it is, and call `renew`. The wait is
 * counted from each token as it arrives, so one renewed some other way starts
 * a wait of its own, and a renewal that changed nothing is due again a floor
 * later. A token that names no expiry schedules nothing: it is renewed when
 * whoever it is shown to refuses it.
 */
internal suspend fun renewWhenDue(token: StateFlow<String?>, renew: suspend () -> Unit) {
    var current = token.value
    while (true) {
        val from = current
        val due = from?.takeIf { it.isNotEmpty() }?.let { refreshDelay(it, System.currentTimeMillis() / 1000.0) }
        if (due == null) {
            current = token.first { it != from }
            continue
        }
        val arrived = withTimeoutOrNull((due * 1000).toLong()) { Arrived(token.first { it != from }) }
        if (arrived != null) {
            current = arrived.token
            continue
        }
        renew()
        current = token.value
    }
}

/** A token that arrived while a renewal waited: told apart from the wait running out, which a null token is not. */
private class Arrived(val token: String?)
