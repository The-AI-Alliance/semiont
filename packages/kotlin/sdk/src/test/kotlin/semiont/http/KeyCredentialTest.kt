package semiont.http

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import semiont.Spec
import semiont.errors.SignInError
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PublicKey
import java.security.Signature
import java.security.interfaces.RSAPrivateCrtKey
import java.util.Base64
import kotlin.math.abs

private const val CLIENT = "semiont-worker-alice-laptop"

private fun aKeyPair(algorithm: String = "RSA"): KeyPair = KeyPairGenerator.getInstance(algorithm).genKeyPair()

private fun privateKeyOf(pair: KeyPair): RSAPrivateCrtKey = pair.private as RSAPrivateCrtKey

/** `encoded` in PEM under `label`, as the launcher writes a worker's key. */
private fun pem(label: String, encoded: ByteArray): String =
    "-----BEGIN $label-----\n${Base64.getMimeEncoder(64, "\n".toByteArray()).encodeToString(encoded)}\n-----END $label-----\n"

private fun decoded(part: String): ByteArray = Base64.getUrlDecoder().decode(part)

private fun signedBy(assertion: String, key: PublicKey): Boolean {
    val (head, body, signature) = assertion.split(".").also { assertEquals(3, it.size, "an assertion is a compact JWT") }
    return Signature.getInstance("SHA256withRSA").run {
        initVerify(key)
        update("$head.$body".toByteArray(Charsets.US_ASCII))
        verify(decoded(signature))
    }
}

/** The assertion's header and claims, once its signature is checked with `key`, as an issuer checks it. */
private fun checked(assertion: String, key: PublicKey): Pair<JsonObject, JsonObject> {
    assertTrue(signedBy(assertion, key), "the assertion is not signed with the key's private half")
    val (head, body) = assertion.split(".").take(2).map { Json.parseToJsonElement(decoded(it).toString(Charsets.UTF_8)).jsonObject }
    return head to body
}

/**
 * A service account that proves itself with a key: each grant carries an
 * assertion signed for it alone, and no secret. What an issuer does with the
 * assertion is done here by hand: its signature is checked with the key's
 * public half, and its claims read. The shape the table states is
 * ClientAssertionCasesTest's.
 */
class KeyCredentialTest {
    private val table = Spec.read("session/client-assertion-cases.json").jsonObject
    private val form = table.getValue("form").jsonArray.map { it.jsonPrimitive.content }
    private val grantType = table.getValue("grantType").jsonPrimitive.content
    private val realms = mutableListOf<Realm>()

    private fun realm() = Realm().also { realms += it }

    @AfterEach
    fun close() = realms.forEach { it.close() }

    @Test
    fun eachGrantCarriesAnAssertionSignedForItAloneAndNoSecret() = runBlocking {
        val realm = realm()
        val first = tokenFor("service-1")
        val second = tokenFor("service-2")
        realm.script("/token", issued(first), issued(second))
        val pair = aKeyPair()
        val service = ServiceToken(KeyCredential.fromPem(realm.origin, CLIENT, pem("PRIVATE KEY", pair.private.encoded)))

        assertEquals("Bearer $first", service.authorization())
        assertEquals(second, service.token(renewed = true))

        val key = privateKeyOf(pair)
        val grants = realm.of("/token")
        assertEquals(2, grants.size)
        val jtis = grants.map { asked ->
            assertEquals(form.sorted(), asked.fields.map { it.first }.sorted())
            val sent = asked.form
            assertEquals(grantType to JWT_BEARER, sent["grant_type"] to sent["client_assertion_type"])
            val (header, claims) = checked(sent.getValue("client_assertion"), pair.public)
            assertEquals(buildJsonObject { put("alg", "RS256"); put("kid", thumbprint(key.modulus, key.publicExponent)) }, header)
            assertEquals(listOf(CLIENT, CLIENT, "${realm.origin}/token"), listOf("iss", "sub", "aud").map { claims.getValue(it).jsonPrimitive.content })
            val issuedAt = claims.getValue("iat").jsonPrimitive.long
            assertEquals(ASSERTION_LIFETIME_SECONDS, claims.getValue("exp").jsonPrimitive.long - issuedAt)
            assertTrue(abs(issuedAt - System.currentTimeMillis() / 1000) < 60, "iat $issuedAt is not now")
            claims.getValue("jti").jsonPrimitive.content
        }
        assertNotEquals(jtis[0], jtis[1], "a grant's assertion is never sent twice")
    }

    @Test
    fun anAssertionAnotherKeySignedIsNotThisAccounts() = runBlocking {
        val realm = realm()
        realm.script("/token", issued(tokenFor("service-1")))
        val pair = aKeyPair()
        ServiceToken(KeyCredential(realm.origin, CLIENT, privateKeyOf(pair))).authorization()
        val assertion = realm.of("/token").single().form.getValue("client_assertion")
        assertTrue(signedBy(assertion, pair.public))
        assertFalse(signedBy(assertion, aKeyPair().public))
    }

    @Test
    fun aKeyCredentialNeverShowsItsKeyAndARefusedGrantNeverShowsItsAssertion() = runBlocking {
        val realm = realm()
        val key = privateKeyOf(aKeyPair())
        val credential = KeyCredential(realm.origin, CLIENT, key)
        val said = credential.toString()
        assertFalse(said.contains("privateKey"), said)
        assertFalse(said.contains(key.privateExponent.toString()) || said.contains(key.privateExponent.toString(16)), said)
        assertFalse(said.contains(Base64.getEncoder().encodeToString(key.encoded)), said)

        // An error body can echo what it was sent: the status is said, never the body.
        realm.script("/token", Said(401, buildJsonObject { put("error", "invalid_client"); put("error_description", "echo") }))
        val refused = assertThrows(SignInError::class.java) { runBlocking { ServiceToken(credential).authorization() } }
        assertEquals(401, refused.status)
        val message = checkNotNull(refused.message)
        assertTrue(message.startsWith("Client-credentials grant for $CLIENT at ") && message.endsWith(" failed (HTTP 401)"), message)
        assertFalse(message.contains("echo"), message)
        val assertion = realm.of("/token").single().form.getValue("client_assertion")
        assertFalse(message.contains(assertion) || refused.toString().contains(assertion), message)
    }

    @Test
    fun aWorkerReadsItsKeyFromPkcs8Pem() {
        val key = privateKeyOf(aKeyPair())
        val credential = KeyCredential.fromPem("https://issuer.example", CLIENT, pem("PRIVATE KEY", key.encoded))
        assertEquals(key, credential.privateKey)
        assertEquals("https://issuer.example" to CLIENT, credential.issuer to credential.clientId)
    }

    @Test
    fun aPemThatIsNotAnRsaPkcs8KeyIsRefusedAndNeverEchoed() {
        val rsa = privateKeyOf(aKeyPair())
        val ec = aKeyPair("EC").private
        val notOne = mapOf(
            pem("RSA PRIVATE KEY", rsa.encoded) to "is not a PKCS#8 PEM",
            pem("ENCRYPTED PRIVATE KEY", rsa.encoded) to "is not a PKCS#8 PEM",
            Base64.getEncoder().encodeToString(rsa.encoded) to "is not a PKCS#8 PEM",
            "-----BEGIN PRIVATE KEY-----\nQUJDR\n-----END PRIVATE KEY-----\n" to "its body is not base64",
            pem("PRIVATE KEY", ec.encoded) to "is not an RSA private key",
            pem("PRIVATE KEY", "not a key".toByteArray()) to "is not an RSA private key",
        )
        for ((text, why) in notOne) {
            val refused = assertThrows(IllegalArgumentException::class.java) { KeyCredential.fromPem("https://issuer.example", CLIENT, text) }
            val message = checkNotNull(refused.message)
            assertTrue(message.contains(why) && message.contains(CLIENT), message)
            val body = text.lines().filterNot { it.startsWith("-----") }.joinToString("")
            assertFalse(body.isNotEmpty() && message.contains(body), message)
        }
    }
}
