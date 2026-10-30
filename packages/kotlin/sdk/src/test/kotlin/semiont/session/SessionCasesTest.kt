@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package semiont.session

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.Recording
import semiont.SemiontClient
import semiont.Spec
import semiont.errors.SemiontError
import semiont.errors.SessionError
import semiont.errors.SignInError
import semiont.errors.SignInErrorCode
import semiont.errors.TransportError
import semiont.signin.HeldSignIn
import semiont.signin.MemorySignIn
import semiont.signin.SCRIPT_CLIENT_ID
import semiont.types.HttpEndpoint
import semiont.types.HttpEndpointProtocol
import semiont.types.KbTarget
import semiont.types.UserResponse
import semiont.types.wireJson
import java.util.Base64

private fun jwt(claims: JsonObject): String {
    val encoded = Base64.getUrlEncoder().withoutPadding()
    return listOf("""{"alg":"RS256","typ":"JWT"}""", claims.toString()).joinToString(".") { encoded.encodeToString(it.toByteArray()) } + ".c2lnbmF0dXJl"
}

/** A token that lives `lifetime` seconds from now, the `n`th of its kind. */
private fun token(lifetime: Long, n: Int): String {
    val now = System.currentTimeMillis() / 1000
    return jwt(buildJsonObject {
        put("iat", now)
        put("exp", now + lifetime)
        put("jti", "token-$n")
    })
}

private fun expired(): String = token(-3600, 99)

private val alice: UserResponse = wireJson.decodeFromString(
    UserResponse.serializer(),
    """{"did":"did:web:example.org:users:alice","email":"alice@example.org","name":"Alice","image":null,"domain":"example.org","isAdmin":false,"isModerator":false,"termsAcceptedAt":null}""",
)

private fun unauthorized() = TransportError.ofStatus("HTTP 401", 401, null)

private val target = KbTarget(id = "kb-alpha", label = "Alpha", endpoint = HttpEndpoint(host = "localhost", port = 4000, protocol = HttpEndpointProtocol.Http))

/** A session's surroundings, and a record of what the session did to them. */
private class World(kept: String?, renewals: List<String?>, validations: List<Any>) {
    val kept = MemorySignIn(kept?.let { HeldSignIn(it, "a-refresh-token", SCRIPT_CLIENT_ID, "https://issuer.test/token", null) })
    val token = MutableStateFlow<String?>(null)
    private val renewalsLeft = ArrayDeque(renewals)
    var renewed = 0
    private val validationsLeft = ArrayDeque(validations)
    val validated = mutableListOf<String>()
    val told = mutableListOf<SessionEndReason>()
    val errors = mutableListOf<SessionError>()

    suspend fun refresh(): String? {
        renewed += 1
        return renewalsLeft.removeFirstOrNull() ?: throw SignInError(SignInErrorCode.Exchange, "the issuer refused")
    }

    suspend fun validate(asked: String): UserResponse {
        validated += asked
        return when (val answer = validationsLeft.removeFirstOrNull() ?: alice) {
            is SemiontError -> throw answer
            else -> answer as UserResponse
        }
    }

    fun session(): SemiontSession {
        val recording = Recording()
        return SemiontSession(target, SemiontClient(recording, recording, recording), token, kept, { refresh() }, { validate(it) }, { told += it }, { errors += it })
    }
}

/**
 * How a client holds a session, held to the cases every SDK runs
 * (specs/src/session/cases.json): when it renews a token, a token's expiry,
 * what it does at its start with the credential it finds kept, and what it
 * does when the gateway refuses a running session's token.
 */
class SessionCasesTest {
    private val table = Spec.read("session/cases.json").jsonObject

    private fun rows(name: String) = table.getValue(name).jsonArray.map { it.jsonObject }

    private fun JsonObject.why() = getValue("why").jsonPrimitive.content

    @TestFactory
    fun aTokenIsRenewedWhenTheTableSays(): List<DynamicTest> = rows("refreshSchedule").map { row ->
        DynamicTest.dynamicTest(row.why()) {
            val token = row["token"]?.jsonPrimitive?.content ?: jwt(row.getValue("claims").jsonObject)
            val delay = row.getValue("delay").takeUnless { it is JsonNull }?.jsonPrimitive?.double
            assertEquals(delay, refreshDelay(token, row.getValue("now").jsonPrimitive.double))
        }
    }

    @TestFactory
    fun aTokenExpiresWhenTheTableSays(): List<DynamicTest> = rows("tokenExpiry").map { row ->
        DynamicTest.dynamicTest(row.why()) {
            val expiry = row.getValue("exp").takeUnless { it is JsonNull }?.jsonPrimitive?.double
            assertEquals(expiry, tokenExpiry(row.getValue("token").jsonPrimitive.content))
        }
    }

    /** The `n`th answer of a script whose last answer repeats. */
    private fun answer(row: JsonObject, who: String, n: Int): String {
        val script = row.getValue(who).jsonArray.map { it.jsonPrimitive.content }
        return script[minOf(n, script.size - 1)]
    }

    private fun gatewaySays(row: JsonObject, n: Int): Any = when (val said = answer(row, "gateway", n)) {
        "accepts" -> alice
        "refuses" -> unauthorized()
        "unreachable" -> TransportError.ofStatus("HTTP 503", 503, null)
        else -> error("the gateway $said")
    }

    private fun issuerSays(row: JsonObject, n: Int, renewed: String): String? = when (val said = answer(row, "issuer", n)) {
        "renews" -> renewed
        "refuses" -> null
        else -> error("the issuer $said")
    }

    // The script's last answer repeats, so a session that asks without end is stopped by one answer more than the case allows.
    private fun oneTooMany() = TransportError.ofStatus("asked more than the case allows", 500, null)

    private fun ends(session: SemiontSession): String = when {
        session.token.value == null -> "signed-out"
        session.user.value == null -> "unconfirmed"
        else -> "signed-in"
    }

    private fun count(row: JsonObject, name: String) = row.getValue(name).jsonPrimitive.int

    /** The session ended as the row states, and one that ended signed out asks nobody anything afterwards, however long it is held. */
    private suspend fun kotlinx.coroutines.test.TestScope.isAsStated(row: JsonObject, world: World, session: SemiontSession, askedBefore: Int) {
        val asks = count(row, "asks")
        val renewals = count(row, "renewals")
        assertEquals(asks to renewals, (world.validated.size - askedBefore) to world.renewed, "how often the gateway and the issuer were asked")
        assertEquals(row.getValue("ends").jsonPrimitive.content, ends(session))
        assertEquals(listOfNotNull(row.getValue("told").takeUnless { it is JsonNull }?.jsonPrimitive?.content), world.told.map { it.wire }, "why the session ended")
        assertEquals(listOfNotNull(row.getValue("error").takeUnless { it is JsonNull }?.jsonPrimitive?.content), world.errors.map { it.code }, "the error reported")
        assertEquals(row.getValue("kept").jsonPrimitive.content.toBooleanStrict(), world.kept.held() != null, "whether a sign-in is still kept")
        if (ends(session) == "signed-out") {
            advanceTimeBy(2 * 60 * 60 * 1000L)
            runCurrent()
            assertEquals(asks to renewals, (world.validated.size - askedBefore) to world.renewed, "what was asked once the session was over")
        }
    }

    @TestFactory
    fun aSessionStartsAsTheTableStates(): List<DynamicTest> = rows("startup").map { row ->
        DynamicTest.dynamicTest(row.why()) {
            runTest {
                val asks = count(row, "asks")
                val renewals = count(row, "renewals")
                val kept = when (row.getValue("stored").jsonPrimitive.content) {
                    "none" -> null
                    "unexpired" -> token(3600, 0)
                    else -> expired()
                }
                val world = World(kept, (0 until renewals).map { issuerSays(row, it, token(3600, it + 1)) }, (0 until asks).map { gatewaySays(row, it) } + oneTooMany())
                world.session().use { session ->
                    session.start()
                    session.ready()
                    isAsStated(row, world, session, 0)
                }
            }
        }
    }

    @TestFactory
    fun aRefusedSessionRenewsAndAsksAsTheTableStates(): List<DynamicTest> = rows("refusal").map { row ->
        DynamicTest.dynamicTest(row.why()) {
            runTest {
                val asks = count(row, "asks")
                val renewals = count(row, "renewals")
                // The session starts signed in: the gateway accepts the kept token. Then the row's answers.
                val world = World(token(3600, 0), (0 until renewals).map { issuerSays(row, it, token(3600, 1)) }, listOf<Any>(alice) + (0 until asks).map { gatewaySays(row, it) } + oneTooMany())
                world.session().use { session ->
                    session.start()
                    session.ready()
                    assertEquals("signed-in", ends(session))
                    val given = session.refresh()
                    assertEquals(row.getValue("given").jsonPrimitive.content.toBooleanStrict(), given != null, "whether refresh gives a token")
                    if (given != null) assertEquals(session.token.value, given)
                    isAsStated(row, world, session, 1)
                }
            }
        }
    }

    @Test
    fun theTableWasRead() {
        assertTrue(rows("startup").size >= 10 && rows("refusal").size >= 4 && rows("refreshSchedule").isNotEmpty() && rows("tokenExpiry").isNotEmpty())
    }
}
