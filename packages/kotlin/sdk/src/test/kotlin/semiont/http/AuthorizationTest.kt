package semiont.http

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.errors.IdentityUnverifiableError
import semiont.errors.IdentityUnverifiableReason
import semiont.errors.SignInError
import semiont.errors.SignInErrorCode
import semiont.identifiers.UserId
import semiont.registry.PENDING_AUTHORIZATION_KEY
import semiont.storage.MemoryStorage
import semiont.storage.SessionStorage
import semiont.types.HttpEndpoint
import semiont.types.HttpEndpointProtocol
import semiont.types.wireJson
import java.net.URI
import java.net.URLDecoder

private const val DID_A = "did:web:example.org:kb-a"
private const val REDIRECT = "http://127.0.0.1:9/callback"

private val DESCRIBED = buildJsonObject {
    put("name", "KB A")
    put("domain", "example.org:kb-a")
    put("gitBranch", "main")
}

private fun endpointOf(realm: Realm): HttpEndpoint = HttpEndpoint(host = "127.0.0.1", port = URI(realm.origin).port.toLong(), protocol = HttpEndpointProtocol.Http)

private val NOWHERE = HttpEndpoint(host = "evil.example/x", port = 4000, protocol = HttpEndpointProtocol.Https)

/** What an address asks: each name once. */
private fun query(address: String): Map<String, String> =
    URI(address).rawQuery.split('&').associate { pair -> pair.split('=', limit = 2).let { URLDecoder.decode(it[0], Charsets.UTF_8) to URLDecoder.decode(it[1], Charsets.UTF_8) } }

/** The sign-in pending in `storage`, when one is. */
private fun pendingIn(storage: SessionStorage): PendingAuthorization? = storage.get(PENDING_AUTHORIZATION_KEY)?.let { wireJson.decodeFromString(PendingAuthorization.serializer(), it) }

/** A sign-in begun at the realm, as `storage` remembers it. */
private suspend fun begun(realm: Realm, storage: SessionStorage): PendingAuthorization {
    beginAuthorization(BeginAuthorizationOptions(endpointOf(realm), REDIRECT), storage)
    return checkNotNull(pendingIn(storage))
}

/** The knowledge base behind the realm's gateway answers a request to describe itself as `describes` says, or refuses to say. */
private fun Realm.describing(describes: JsonObject?) {
    onEmit = { emit ->
        val correlation = emit["correlationId"]?.jsonPrimitive?.content
        if (correlation != null && emit["channel"]?.jsonPrimitive?.content == "browse:kb-requested") {
            send(
                buildJsonObject {
                    if (describes == null) {
                        put("channel", "browse:kb-failed")
                        put("payload", buildJsonObject { put("message", "this knowledge base cannot say what it is") })
                    } else {
                        put("channel", "browse:kb-result")
                        put("payload", buildJsonObject { put("response", describes) })
                    }
                    put("correlationId", correlation)
                },
            )
        }
    }
}

/** A person's sign-in by a page redirect: the authorization-code grant with PKCE, and the question a completed sign-in asks, who the knowledge base is. */
class AuthorizationTest {
    // The authorization-code grant, with PKCE.

    @Test
    fun theChallengeIsTheOneRfc7636GivesForItsVerifier() {
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
    }

    @Test
    fun beginningASignInRemembersItAndBuildsTheUrlAroundWhatItRemembered() = runBlocking {
        Realm().use { realm ->
            val storage = MemoryStorage()
            val address = beginAuthorization(BeginAuthorizationOptions(endpointOf(realm), REDIRECT, "kb-a", DID_A, "KB A"), storage)
            val record = checkNotNull(pendingIn(storage))
            assertTrue(address.startsWith("${realm.origin}/authorize?"), address)
            assertEquals(
                mapOf(
                    "response_type" to "code",
                    "client_id" to "semiont-browser",
                    "redirect_uri" to REDIRECT,
                    "scope" to "openid email profile offline_access",
                    "state" to record.state,
                    "code_challenge" to codeChallenge(record.verifier),
                    "code_challenge_method" to "S256",
                ),
                query(address),
            )
            assertEquals(endpointOf(realm), record.target)
            assertEquals("${realm.origin}/token", record.issuer.token)
            assertEquals(Triple("kb-a", DID_A, "KB A"), Triple(record.kbId, record.expectedDid, record.expectedName))
            // Neither is guessable, and neither is the other.
            assertTrue(record.verifier.length >= 43)
            assertTrue(record.state.length >= 32)
            assertTrue(record.verifier != record.state)
            // Kept as every SDK keeps it, so a sign-in another SDK began is one this completes.
            assertEquals(
                setOf("state", "verifier", "redirectUri", "target", "issuer", "kbId", "expectedDid", "expectedName"),
                wireJson.parseToJsonElement(checkNotNull(storage.get(PENDING_AUTHORIZATION_KEY))).jsonObject.keys,
            )
        }
    }

    @Test
    fun anIssuersAuthorizationAddressThatAlreadyAsksSomethingKeepsIt() = runBlocking {
        Realm().use { realm ->
            val asking = "${realm.origin}/authorize?prompt=login"
            realm.script(
                "/.well-known/openid-configuration",
                Said(200, buildJsonObject {
                    put("issuer", realm.origin)
                    put("authorization_endpoint", asking)
                    put("token_endpoint", "${realm.origin}/token")
                }),
            )
            val address = beginAuthorization(BeginAuthorizationOptions(endpointOf(realm), REDIRECT), MemoryStorage())
            assertTrue(address.startsWith("$asking&"), address)
            val asked = query(address)
            assertEquals(Triple("login", "code", "S256"), Triple(asked["prompt"], asked["response_type"], asked["code_challenge_method"]))
        }
    }

    @Test
    fun aSignInToAHostThatIsNoHostsNameAsksNobodyAndRemembersNothing() {
        val storage = MemoryStorage()
        val refused = assertThrows(SignInError::class.java) { runBlocking { beginAuthorization(BeginAuthorizationOptions(NOWHERE, REDIRECT), storage) } }
        assertEquals(SignInErrorCode.Discovery to "Invalid KB hostname: \"evil.example/x\"", refused.reason to refused.message)
        assertNull(pendingIn(storage))
    }

    @Test
    fun completingASignInExchangesTheCodeWithItsVerifierOnce() = runBlocking {
        Realm().use { realm ->
            val storage = MemoryStorage()
            val record = begun(realm, storage)
            realm.script("/token", issued("an-access-token", "a-refresh-token"))
            val callback = "$REDIRECT?state=${record.state}&code=the-code"

            val (completed, tokens) = completeAuthorization(callback, storage)

            assertEquals(record, completed)
            assertEquals(IssuedTokens("an-access-token", "a-refresh-token"), tokens)
            assertEquals(
                listOf(
                    mapOf(
                        "grant_type" to "authorization_code",
                        "code" to "the-code",
                        "redirect_uri" to REDIRECT,
                        "client_id" to "semiont-browser",
                        "code_verifier" to record.verifier,
                    ),
                ),
                realm.of("/token").map { it.form },
            )
            // The pending record is gone: the same callback again completes nothing.
            assertNull(pendingIn(storage))
            val replayed = assertThrows(SignInError::class.java) { runBlocking { completeAuthorization(callback, storage) } }
            assertEquals(SignInErrorCode.NoPending, replayed.reason)
            assertEquals(1, realm.of("/token").size)
        }
    }

    @TestFactory
    fun aResponseThatIsNotThePendingSignInsIsRefusedAndNothingIsExchanged(): List<DynamicTest> = listOf(
        Triple("state=another&code=the-code", SignInErrorCode.State, "The sign-in response does not belong to the pending sign-in"),
        Triple("error=access_denied&error_description=The+person+said+no", SignInErrorCode.Denied, "The person said no"),
        Triple("error=server_error", SignInErrorCode.Exchange, "server_error"),
        Triple("code=the-code", SignInErrorCode.State, "The sign-in response does not belong to the pending sign-in"),
    ).map { (response, code, message) ->
        DynamicTest.dynamicTest(response) {
            runBlocking {
                Realm().use { realm ->
                    val storage = MemoryStorage()
                    realm.script("/token", issued("an-access-token", "a-refresh-token"))
                    begun(realm, storage)
                    val refused = assertThrows(SignInError::class.java) { runBlocking { completeAuthorization("$REDIRECT?$response", storage) } }
                    assertEquals(code to message, refused.reason to refused.message)
                    // Refused by what came back, not by the issuer: no status, as though the issuer had answered.
                    assertNull(refused.status)
                    // Refused or not, a sign-in is completed once.
                    assertNull(pendingIn(storage))
                    assertEquals(emptyList<Asked>(), realm.of("/token"))
                }
            }
        }
    }

    @Test
    fun aResponseThatCarriesNoCodeOrIsNoUrlIsRefusedAndNothingIsExchanged() = runBlocking {
        Realm().use { realm ->
            val storage = MemoryStorage()
            var record = begun(realm, storage)
            val withoutACode = assertThrows(SignInError::class.java) { runBlocking { completeAuthorization("$REDIRECT?state=${record.state}", storage) } }
            assertEquals(SignInErrorCode.Exchange to "The sign-in response carries no authorization code", withoutACode.reason to withoutACode.message)

            record = begun(realm, storage)
            val relative = assertThrows(SignInError::class.java) { runBlocking { completeAuthorization("/callback?state=${record.state}&code=the-code", storage) } }
            assertEquals(SignInErrorCode.Exchange, relative.reason)
            assertTrue(checkNotNull(relative.message).startsWith("The sign-in response is not a URL"), relative.message)

            assertEquals(emptyList<Asked>(), realm.of("/token"))
        }
    }

    @Test
    fun whatIsPendingAndDoesNotReadAsASignInIsNoSignInAndIsTaken() {
        val storage = MemoryStorage()
        storage.set(PENDING_AUTHORIZATION_KEY, """{"state":"s"}""")
        val refused = assertThrows(SignInError::class.java) { runBlocking { completeAuthorization("$REDIRECT?state=s&code=the-code", storage) } }
        assertEquals(SignInErrorCode.NoPending to "No sign-in is pending here", refused.reason to refused.message)
        assertNull(storage.get(PENDING_AUTHORIZATION_KEY))
    }

    @Test
    fun aTokenEndpointThatRefusesTheCodeSaysWhatItSaidAndTheStatusItAnswered() = runBlocking {
        Realm().use { realm ->
            val storage = MemoryStorage()
            val record = begun(realm, storage)
            realm.script("/token", Said(400, buildJsonObject {
                put("error", "invalid_grant")
                put("error_description", "Code not valid")
            }))
            val refused = assertThrows(SignInError::class.java) { runBlocking { completeAuthorization("$REDIRECT?state=${record.state}&code=the-code", storage) } }
            assertEquals(SignInErrorCode.Exchange to 400, refused.reason to refused.status)
            assertEquals("The issuer refused the token request (invalid_grant: Code not valid)", refused.message)
        }
    }

    @Test
    fun aTokenEndpointThatIssuesNoRefreshTokenIsRefused() = runBlocking {
        Realm().use { realm ->
            val storage = MemoryStorage()
            val record = begun(realm, storage)
            realm.script("/token", issued("an-access-token"))
            val refused = assertThrows(SignInError::class.java) { runBlocking { completeAuthorization("$REDIRECT?state=${record.state}&code=the-code", storage) } }
            assertEquals(SignInErrorCode.Exchange, refused.reason)
            assertTrue(checkNotNull(refused.message).contains("no refresh token"), refused.message)
        }
    }

    // What a completed sign-in learns.

    @Test
    fun askedWithATokenTheKnowledgeBaseSaysWhoItIs() = runBlocking {
        Realm(holdsStreams = true).use { realm ->
            realm.describing(DESCRIBED)
            val asking = tokenFor("asking")
            val identity = withTimeout(10_000) { describeConnection(endpointOf(realm), asking) }
            assertEquals(UserId(DID_A), identity.did)
            assertEquals("KB A" to "main", identity.description.name to identity.description.gitBranch)
            // Asked with the token it was given, for that one operation.
            assertEquals(listOf("Bearer $asking"), realm.of("/bus/emit").map { it.authorization })
            assertEquals(listOf("browse:kb-requested"), realm.emits.map { it.getValue("channel").jsonPrimitive.content })
        }
    }

    @Test
    fun aKnowledgeBaseThatAnswersItCannotSayWhatItIsIsNotReported() = runBlocking {
        Realm(holdsStreams = true).use { realm ->
            realm.describing(null)
            val refused = assertThrows(IdentityUnverifiableError::class.java) { runBlocking { withTimeout(10_000) { describeConnection(endpointOf(realm), tokenFor("asking")) } } }
            assertEquals(IdentityUnverifiableReason.NotReported, refused.reason)
            assertEquals("not-reported", refused.code)
        }
    }

    @Test
    fun aKnowledgeBaseAtAHostThatIsNoHostsNameIsNotAskedWhoItIs() {
        val refused = assertThrows(IdentityUnverifiableError::class.java) { runBlocking { describeConnection(NOWHERE, tokenFor("asking")) } }
        assertEquals(IdentityUnverifiableReason.Unreachable to "Invalid KB hostname: \"evil.example/x\"", refused.reason to refused.message)
    }
}
