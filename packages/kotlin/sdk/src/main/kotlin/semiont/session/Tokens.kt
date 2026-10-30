package semiont.session

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
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
internal fun textClaim(token: String, name: String): String? = (claims(token)?.get(name) as? JsonPrimitive)?.takeIf { it.isString }?.content

/** When a token expires, by its `exp` claim, in seconds since the epoch. Null when it names no time. */
internal fun tokenExpiry(token: String): Double? = claims(token)?.let { seconds(it, "exp") }

/** Whether a token is past its expiry at `now`, in seconds since the epoch. One that names no expiry is read as expired: nothing says it is still good. */
internal fun isTokenExpired(token: String, now: Double): Boolean {
    val expiry = tokenExpiry(token)
    return expiry == null || expiry < now
}
