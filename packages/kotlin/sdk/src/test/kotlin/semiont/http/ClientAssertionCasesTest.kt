package semiont.http

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.Spec
import semiont.sameJson
import java.math.BigInteger
import java.util.Base64

/**
 * A service account's assertion of itself, held to the cases every SDK that
 * signs one runs (specs/src/session/client-assertion-cases.json): the
 * thumbprint a key is named by, and the header and claims an assertion
 * carries. The signature over them, and the form a grant posts, are held in
 * KeyCredentialTest, where a grant's assertion is checked with the key's
 * public half as an issuer checks it.
 */
class ClientAssertionCasesTest {
    private val table = Spec.read("session/client-assertion-cases.json").jsonObject

    private fun rows(name: String) = table.getValue(name).jsonArray.map { it.jsonObject }

    private fun JsonObject.text(name: String) = getValue(name).jsonPrimitive.also { assertTrue(it.isString, "$name is not text") }.content

    /** A JWK member: the big-endian unsigned number its base64url spells. */
    private fun number(member: String) = BigInteger(1, Base64.getUrlDecoder().decode(member))

    /** The modulus and public exponent of the row's key. */
    private fun keyOf(row: JsonObject): Pair<BigInteger, BigInteger> {
        val jwk = row.getValue("jwk").jsonObject
        assertEquals("RSA", jwk.text("kty"), "${row.text("why")}: its key is not RSA")
        return number(jwk.text("n")) to number(jwk.text("e"))
    }

    @TestFactory
    fun aKeyIsNamedByItsThumbprint(): List<DynamicTest> = rows("thumbprints").map { row ->
        DynamicTest.dynamicTest(row.text("why")) {
            val (modulus, publicExponent) = keyOf(row)
            assertEquals(row.text("thumbprint"), thumbprint(modulus, publicExponent))
        }
    }

    @TestFactory
    fun anAssertionCarriesTheHeaderAndClaimsTheTableStates(): List<DynamicTest> = rows("cases").map { row ->
        DynamicTest.dynamicTest(row.text("why")) {
            val (modulus, publicExponent) = keyOf(row)
            val header = assertionHeader(modulus, publicExponent)
            assertTrue(sameJson(row.getValue("header"), header)) { "the header is $header" }
            val issuedAt = row.getValue("issuedAt").jsonPrimitive.also { assertTrue(!it.isString, "issuedAt is not a number") }.long
            val claims = assertionClaims(row.text("clientId"), row.text("tokenEndpoint"), issuedAt, row.text("jti"))
            assertTrue(sameJson(row.getValue("claims"), claims)) { "the claims are $claims" }
        }
    }

    @Test
    fun anAssertionIsOfTheTablesTypeAndLivesAsLongAsItSays() {
        // The form a grant posts is held where a grant is made, in KeyCredentialTest.
        assertEquals(table.text("assertionType"), JWT_BEARER)
        assertEquals(table.getValue("lifetimeSeconds").jsonPrimitive.long, ASSERTION_LIFETIME_SECONDS)
    }
}
