package semiont.http

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.RSAPrivateCrtKey
import java.util.Base64

/*
 * A service account's assertion of itself, signed with its own key (RFC 7523
 * §2.2, OpenID Connect's `private_key_jwt`). The issuer holds the key's public
 * half, registered on the account's client, and checks the signature with it:
 * the private key never leaves the process, and no secret is sent. The
 * assertion's shape is specs/src/session/client-assertion-cases.json's.
 */

/** The grant's `client_assertion_type` for an assertion that is a JWT. */
internal const val JWT_BEARER = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"

/** How long after it is made an assertion is good for. */
internal const val ASSERTION_LIFETIME_SECONDS = 60L

private val base64Url = Base64.getUrlEncoder().withoutPadding()

private val random = SecureRandom()

/** `value`'s big-endian bytes, unsigned: two's complement's leading zero byte dropped. */
private fun unsigned(value: BigInteger): ByteArray {
    val bytes = value.toByteArray()
    return if (bytes.size > 1 && bytes[0] == 0.toByte()) bytes.copyOfRange(1, bytes.size) else bytes
}

/** The JWK thumbprint (RFC 7638) of the RSA key `modulus` and `publicExponent` make: the SHA-256 of `e`, `kty` and `n`, in that order, with no whitespace. */
internal fun thumbprint(modulus: BigInteger, publicExponent: BigInteger): String {
    val members = """{"e":"${base64Url.encodeToString(unsigned(publicExponent))}","kty":"RSA","n":"${base64Url.encodeToString(unsigned(modulus))}"}"""
    return base64Url.encodeToString(MessageDigest.getInstance("SHA-256").digest(members.toByteArray(Charsets.UTF_8)))
}

/** An assertion's header: RS256, and the key it is signed with, by its thumbprint. */
internal fun assertionHeader(modulus: BigInteger, publicExponent: BigInteger): JsonObject = buildJsonObject {
    put("alg", "RS256")
    put("kid", thumbprint(modulus, publicExponent))
}

/** An assertion's claims: the client is its issuer and its subject, and the token endpoint its audience. */
internal fun assertionClaims(clientId: String, tokenEndpoint: String, issuedAt: Long, jti: String): JsonObject = buildJsonObject {
    put("iss", clientId)
    put("sub", clientId)
    put("aud", tokenEndpoint)
    put("jti", jti)
    put("iat", issuedAt)
    put("exp", issuedAt + ASSERTION_LIFETIME_SECONDS)
}

/** The assertion, signed: a compact JWT of `assertionHeader` and `assertionClaims`, RS256 with `key`. */
internal fun clientAssertion(key: RSAPrivateCrtKey, clientId: String, tokenEndpoint: String, issuedAt: Long, jti: String): String {
    val signingInput = listOf(assertionHeader(key.modulus, key.publicExponent), assertionClaims(clientId, tokenEndpoint, issuedAt, jti))
        .joinToString(".") { base64Url.encodeToString(it.toString().toByteArray(Charsets.UTF_8)) }
    val signature = Signature.getInstance("SHA256withRSA").run {
        initSign(key)
        update(signingInput.toByteArray(Charsets.US_ASCII))
        sign()
    }
    return "$signingInput.${base64Url.encodeToString(signature)}"
}

/** An assertion's `jti`: 128 random bits, as 32 hex digits. */
internal fun freshJti(): String = ByteArray(16).also(random::nextBytes).toHexString()
