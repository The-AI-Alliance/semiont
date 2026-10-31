package semiont.http

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import semiont.errors.IdentityUnverifiableError
import semiont.errors.IdentityUnverifiableReason
import semiont.errors.SignInError
import semiont.errors.SignInErrorCode
import semiont.identifiers.ResourceId
import semiont.live.recorded
import semiont.registry.SemiontBrowser
import semiont.registry.SemiontBrowserConfig
import semiont.registry.StoredSession
import semiont.registry.saveKnowledgeBases
import semiont.registry.storeSession
import semiont.registry.storedSession
import semiont.session.SemiontSession
import semiont.storage.MemoryStorage
import semiont.storage.SessionStorage
import semiont.types.HttpEndpoint
import semiont.types.HttpEndpointProtocol
import semiont.types.KnowledgeBase
import semiont.types.LocalEndpoint
import java.net.URI
import java.net.URLDecoder

private const val KB_A = "kb-a"
private const val DID_A = "did:web:example.org:kb-a"
private const val CALLBACK = "http://127.0.0.1:9/callback"

private val ALICE: JsonObject = Json.parseToJsonElement(
    """{"did":"did:web:example.org:users:alice","email":"alice@example.org","name":"Alice","image":null,"domain":"example.org","isAdmin":false,"isModerator":false,"termsAcceptedAt":null}""",
).jsonObject

private val DESCRIBES = buildJsonObject {
    put("name", "KB A")
    put("domain", "example.org:kb-a")
    put("gitBranch", "main")
}

private fun Realm.endpoint(): HttpEndpoint = HttpEndpoint(host = "127.0.0.1", port = URI(origin).port.toLong(), protocol = HttpEndpointProtocol.Http)

private fun Realm.registered(): KnowledgeBase = KnowledgeBase(KB_A, "KB A", endpoint(), DID_A)

/** A session kept for the browser client, renewed and revoked at the realm's issuer. */
private fun Realm.kept(access: String, refresh: String): StoredSession = StoredSession(access, refresh, "semiont-browser", "$origin/token", "$origin/revoke")

/** The gateway says who a token is, as often as it is asked. */
private fun Realm.knowsAlice() = repeat(10) { script("/api/users/me", Said(200, ALICE)) }

/**
 * The knowledge base behind the realm's gateway: it describes itself as
 * `describes` says, or refuses to say when that is null, and describes any
 * resource it is asked for.
 */
private class Behind(private val realm: Realm) {
    @Volatile
    var describes: JsonObject? = DESCRIBES

    init {
        realm.onEmit = { emit ->
            val correlation = emit["correlationId"]?.jsonPrimitive?.content
            val payload = emit["payload"]?.jsonObject
            if (correlation != null && payload != null) {
                when (emit["channel"]?.jsonPrimitive?.content) {
                    "browse:kb-requested" -> answer(correlation, describes?.let { "browse:kb-result" to buildJsonObject { put("response", it) } } ?: ("browse:kb-failed" to buildJsonObject { put("message", "this knowledge base cannot say what it is") }))
                    "browse:resource-requested" -> {
                        val resource = payload.getValue("resourceId").jsonPrimitive.content
                        answer(
                            correlation,
                            "browse:resource-result" to buildJsonObject {
                                put("resourceId", resource)
                                put("response", buildJsonObject {
                                    put("resource", buildJsonObject {
                                        put("@context", "https://schema.org")
                                        put("@id", resource)
                                        put("name", resource)
                                        put("representations", kotlinx.serialization.json.JsonArray(emptyList()))
                                    })
                                    put("lastSequence", 1)
                                })
                            },
                        )
                    }
                }
            }
        }
    }

    private fun answer(correlation: String, said: Pair<String, JsonObject>) = realm.send(buildJsonObject {
        put("channel", said.first)
        put("payload", said.second)
        put("correlationId", correlation)
    })
}

private fun browserOver(storage: SessionStorage) = SemiontBrowser(SemiontBrowserConfig(storage, HttpSessionFactory()))

private suspend fun live(browser: SemiontBrowser): SemiontSession = withTimeout(10_000) {
    while (browser.activeSession.value == null) delay(10)
    checkNotNull(browser.activeSession.value)
}

private suspend fun until(what: String, seen: () -> Boolean) {
    kotlinx.coroutines.withTimeoutOrNull(10_000) { while (!seen()) delay(10) } ?: throw AssertionError("$what did not happen")
}

/** What an address asks: each name once. */
private fun asked(address: String): Map<String, String> =
    URI(address).rawQuery.split('&').associate { pair -> pair.split('=', limit = 2).let { URLDecoder.decode(it[0], Charsets.UTF_8) to URLDecoder.decode(it[1], Charsets.UTF_8) } }

/** A registry's sessions over HTTP, and a person's sign-in by a page redirect landing on one. */
class RegistryHttpTest {
    @Test
    fun aRegistryBringsUpASessionThatSaysWhoItIsAndRenewsAnExpiredToken() = runBlocking {
        Realm().use { realm ->
            Behind(realm)
            realm.knowsAlice()
            val storage = MemoryStorage()
            saveKnowledgeBases(storage, listOf(realm.registered()))
            storeSession(storage, KB_A, realm.kept(tokenFor("expired", -10), "r1"))
            val renewed = tokenFor("renewed")
            realm.script("/token", issued(renewed, "r2"))

            browserOver(storage).use { browser ->
                val session = live(browser)
                session.ready()
                assertEquals(renewed, session.token.value)
                // The gateway was asked about the renewed token alone: the expired one was renewed before anyone was asked.
                assertEquals(listOf("Bearer $renewed"), realm.of("/api/users/me").map { it.authorization })
                assertEquals("did:web:example.org:users:alice", checkNotNull(session.user.value).did.value)
                assertEquals(
                    mapOf("grant_type" to "refresh_token", "refresh_token" to "r1", "client_id" to "semiont-browser"),
                    realm.of("/token").single().form,
                )
                assertEquals(realm.kept(renewed, "r2"), storedSession(storage, KB_A))
            }
        }
    }

    @Test
    fun aRegistryOverHttpCannotBuildASessionForWhatIsNotAtAGateway() = runBlocking {
        val storage = MemoryStorage()
        saveKnowledgeBases(storage, listOf(KnowledgeBase("kb-local", "Here", LocalEndpoint(kbId = "here"), DID_A)))
        browserOver(storage).use { browser ->
            val refused = withTimeout(10_000) { browser.errors().use { it.first() } }
            assertEquals(
                Triple("session.construct-failed", "kb-local", "A session over HTTP cannot be built for endpoint kind \"local\""),
                Triple(refused.code, refused.kbId, refused.message),
            )
            assertNull(browser.activeSession.value)
        }
    }

    @Test
    fun aRegistryOverHttpPutsNoHostThatIsNoHostsNameIntoAUrl() = runBlocking {
        val storage = MemoryStorage()
        val nowhere = HttpEndpoint(host = "evil.example/x", port = 4000, protocol = HttpEndpointProtocol.Https)
        saveKnowledgeBases(storage, listOf(KnowledgeBase(KB_A, "KB A", nowhere, DID_A)))
        browserOver(storage).use { browser ->
            val refused = withTimeout(10_000) { browser.errors().use { it.first() } }
            assertEquals(
                Triple("session.construct-failed", KB_A, "Invalid KB hostname: \"evil.example/x\""),
                Triple(refused.code, refused.kbId, refused.message),
            )
        }
    }

    @Test
    fun signingOutOfARegistryRevokesTheRefreshTokenAtItsIssuer() = runBlocking {
        Realm().use { realm ->
            Behind(realm)
            realm.knowsAlice()
            realm.script("/revoke", Said(200, JsonObject(emptyMap())))
            val storage = MemoryStorage()
            saveKnowledgeBases(storage, listOf(realm.registered()))
            storeSession(storage, KB_A, realm.kept(tokenFor("access"), "r1"))

            browserOver(storage).use { browser ->
                live(browser)
                browser.signOut(KB_A)
                until("the issuer was told") { realm.of("/revoke").isNotEmpty() }
                assertEquals(
                    mapOf("token" to "r1", "token_type_hint" to "refresh_token", "client_id" to "semiont-browser"),
                    realm.of("/revoke").single().form,
                )
                assertNull(storedSession(storage, KB_A))
                assertNull(browser.activeSession.value)
            }
        }
    }

    @Test
    fun aRegistrysSessionResumesItsStreamFromThePlaceItsStorageKept() = runBlocking {
        Realm().use { realm ->
            Behind(realm)
            realm.knowsAlice()
            val storage = MemoryStorage()
            saveKnowledgeBases(storage, listOf(realm.registered()))
            storeSession(storage, KB_A, realm.kept(tokenFor("access"), "r1"))
            val places = "semiont.lastEventId.$KB_A"
            storage.set(places, """{"res-1":"p-5"}""")

            fun resumedFrom(): String? = realm.subscriptions.flatMap { subscription ->
                (subscription["scoped"] as? kotlinx.serialization.json.JsonArray).orEmpty().map { it.jsonObject }
            }.firstOrNull { it["scope"]?.jsonPrimitive?.content == "res-1" && "lastEventId" in it }?.get("lastEventId")?.jsonPrimitive?.content

            browserOver(storage).use { browser ->
                val session = live(browser)
                session.ready()
                // Watching a query of the resource holds its scope.
                val watching = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Default).launchWatching(session)
                try {
                    until("the stream names the scope") { resumedFrom() != null }
                    assertEquals("p-5", resumedFrom())
                    // A recorded event of the scope moves the place, which is kept once the caches have taken it in and written what they hold.
                    realm.send(
                        buildJsonObject {
                            put("channel", "mark:archived")
                            put("scope", "res-1")
                            put("payload", recorded("mark:archived", ResourceId("res-1")))
                        },
                        id = "p-9",
                    )
                    until("the place is kept") { storage.get(places)?.let { Json.parseToJsonElement(it) } == Json.parseToJsonElement("""{"res-1":"p-9"}""") }
                } finally {
                    watching.cancel()
                }
            }
        }
    }

    @Test
    fun aRegistrysSignInRegistersTheKnowledgeBaseUnderWhatItSaysItIs() = runBlocking {
        Realm().use { realm ->
            Behind(realm)
            realm.knowsAlice()
            val storage = MemoryStorage()
            val access = tokenFor("access")
            realm.script("/token", issued(access, "a-refresh-token"))

            browserOver(storage).use { browser ->
                val options = BeginAuthorizationOptions(realm.endpoint(), CALLBACK, expectedDid = "did:web:example.org:another", expectedName = "Another")
                val address = beginSignIn(browser, options)
                val outcome = withTimeout(10_000) { completeSignIn(browser, "$CALLBACK?state=${asked(address).getValue("state")}&code=the-code") }

                assertEquals(Triple(DID_A, "KB A", realm.endpoint()), Triple(outcome.kb.did, outcome.kb.label, outcome.kb.endpoint))
                assertEquals("main", checkNotNull(outcome.kb.lastRead).gitBranch)
                // What the person believed they clicked is said back, not acted on.
                assertEquals("did:web:example.org:another" to "Another", checkNotNull(outcome.expected).let { it.did to it.name })
                assertEquals(listOf(outcome.kb.id to DID_A), browser.kbs.value.map { it.id to it.did })
                assertEquals(realm.kept(access, "a-refresh-token"), storedSession(storage, outcome.kb.id))
                assertEquals(outcome.kb.id, live(browser).kb.id)
                // The code was exchanged for the browser client.
                val exchanged = realm.of("/token").first().form
                assertEquals(Triple("authorization_code", "semiont-browser", "the-code"), Triple(exchanged["grant_type"], exchanged["client_id"], exchanged["code"]))
            }
        }
    }

    @Test
    fun aKnowledgeBaseThatCannotSayWhoItIsIsNotRegistered() = runBlocking {
        Realm().use { realm ->
            val behind = Behind(realm)
            val storage = MemoryStorage()
            browserOver(storage).use { browser ->
                val options = BeginAuthorizationOptions(realm.endpoint(), CALLBACK)

                behind.describes = null
                realm.script("/token", issued(tokenFor("first"), "r"))
                var address = beginSignIn(browser, options)
                val unreported = assertThrows(IdentityUnverifiableError::class.java) {
                    runBlocking { withTimeout(10_000) { completeSignIn(browser, "$CALLBACK?state=${asked(address).getValue("state")}&code=the-code") } }
                }
                assertEquals(IdentityUnverifiableReason.NotReported, unreported.reason)

                // An emit the gateway refuses reaches nobody to ask.
                behind.describes = DESCRIBES
                realm.script("/bus/emit", Said(401, buildJsonObject { put("error", "The token is not one this gateway admits") }))
                realm.script("/token", issued(tokenFor("second"), "r"))
                address = beginSignIn(browser, options)
                val unreached = assertThrows(IdentityUnverifiableError::class.java) {
                    runBlocking { withTimeout(10_000) { completeSignIn(browser, "$CALLBACK?state=${asked(address).getValue("state")}&code=the-code") } }
                }
                assertEquals(IdentityUnverifiableReason.Unreachable, unreached.reason)

                assertEquals(emptyList<KnowledgeBase>() to null, browser.kbs.value to browser.activeKbId.value)
            }
        }
    }

    @Test
    fun aCallbackThatIsNotThePendingSignInsRegistersNothing() = runBlocking {
        Realm().use { realm ->
            browserOver(MemoryStorage()).use { browser ->
                beginSignIn(browser, BeginAuthorizationOptions(realm.endpoint(), CALLBACK))
                val refused = assertThrows(SignInError::class.java) { runBlocking { completeSignIn(browser, "$CALLBACK?state=another&code=the-code") } }
                assertEquals(SignInErrorCode.State to "The sign-in response does not belong to the pending sign-in", refused.reason to refused.message)
                assertEquals(emptyList<KnowledgeBase>(), browser.kbs.value)
                assertEquals(emptyList<Asked>(), realm.of("/token"))
            }
        }
    }
}

/** Collect a live query of `res-1`, holding its scope for as long as it is collected. */
private fun kotlinx.coroutines.CoroutineScope.launchWatching(session: SemiontSession): kotlinx.coroutines.Job =
    launch { session.client.browse.resource(ResourceId("res-1")).collect { } }
