package semiont.http

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import semiont.errors.SignInError
import semiont.errors.SignInErrorCode
import semiont.identifiers.UserId
import semiont.signin.HeldSignIn
import semiont.signin.MemorySignIn
import semiont.signin.SCRIPT_CLIENT_ID
import semiont.types.HttpEndpoint
import semiont.types.HttpEndpointProtocol
import semiont.types.KbTarget
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.URLDecoder
import java.util.Base64
import java.util.concurrent.ConcurrentLinkedDeque
import java.util.concurrent.CopyOnWriteArrayList

/** One answer of the fake: its status and its JSON body. */
internal class Said(val status: Int, val body: JsonObject)

/** One request the fake was asked: its method, path, headers and form, each field as it was sent. */
internal class Asked(val method: String, val path: String, val authorization: String?, val fields: List<Pair<String, String>>) {
    val form: Map<String, String> get() = fields.toMap()
}

/**
 * A knowledge base's gateway and the issuer it trusts, in one server, answering
 * each path with what a test gives it. It holds the latest stream a client
 * opens, keeps what each emit carried, and is given each to answer
 * (`onEmit`), on that stream (`send`).
 */
internal class Realm(trustsAnIssuer: Boolean = true) : AutoCloseable {
    private val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
    val origin: String = "http://127.0.0.1:${server.address.port}"
    val asked = CopyOnWriteArrayList<Asked>()
    val scripted = mutableMapOf<String, ConcurrentLinkedDeque<Said>>()
    val emits = CopyOnWriteArrayList<JsonObject>()

    /** What each stream a client opened asked for. */
    val subscriptions = CopyOnWriteArrayList<JsonObject>()

    @Volatile
    var onEmit: (JsonObject) -> Unit = {}

    @Volatile
    private var stream: OutputStream? = null

    fun script(path: String, vararg said: Said) {
        scripted.getOrPut(path) { ConcurrentLinkedDeque() }.addAll(said)
    }

    /** Write a frame on the stream the client holds, under the event id `id` when it has one. */
    fun send(frame: JsonObject, id: String? = null) {
        val out = checkNotNull(stream) { "no client holds a stream" }
        synchronized(out) {
            out.write("${id?.let { "id: $it\n" }.orEmpty()}event: bus-event\ndata: $frame\n\n".toByteArray())
            out.flush()
        }
    }

    private fun answer(exchange: HttpExchange, said: Said) {
        val body = said.body.toString().toByteArray()
        exchange.responseHeaders.add("Content-Type", "application/json")
        exchange.sendResponseHeaders(said.status, body.size.toLong())
        exchange.responseBody.write(body)
        exchange.close()
    }

    init {
        server.createContext("/") { exchange ->
            val text = String(exchange.requestBody.readAllBytes())
            val fields = if (text.contains('=') && !text.startsWith("{")) {
                text.split('&').map { pair -> pair.split('=', limit = 2).let { URLDecoder.decode(it[0], Charsets.UTF_8) to URLDecoder.decode(it[1], Charsets.UTF_8) } }
            } else {
                emptyList()
            }
            val path = exchange.requestURI.path
            asked += Asked(exchange.requestMethod, path, exchange.requestHeaders.getFirst("Authorization"), fields)
            // What a test scripts for a path is answered before what the realm says of itself.
            val scriptedFirst = scripted[path]?.pollFirst()
            if (scriptedFirst != null) {
                answer(exchange, scriptedFirst)
                return@createContext
            }
            when {
                path == "/bus/subscribe" -> {
                    subscriptions += Json.parseToJsonElement(text).jsonObject
                    exchange.responseHeaders.add("Content-Type", "text/event-stream")
                    exchange.sendResponseHeaders(200, 0)
                    val out = exchange.responseBody
                    out.write(": open\n\n".toByteArray())
                    out.flush()
                    stream = out
                }
                path == "/bus/emit" -> {
                    val emit = Json.parseToJsonElement(text).jsonObject
                    emits += emit
                    answer(exchange, Said(202, buildJsonObject { put("subscribers", 1) }))
                    onEmit(emit)
                }
                path == "/.well-known/oauth-protected-resource" && !trustsAnIssuer -> answer(exchange, Said(404, buildJsonObject { put("error", "not found") }))
                path == "/.well-known/oauth-protected-resource" -> answer(exchange, Said(200, buildJsonObject {
                    put("resource", origin)
                    put("authorization_servers", buildJsonArray { add(JsonPrimitive(origin)) })
                    put("bearer_methods_supported", buildJsonArray { add(JsonPrimitive("header")) })
                }))
                path == "/.well-known/openid-configuration" -> answer(exchange, Said(200, buildJsonObject {
                    put("issuer", origin)
                    put("authorization_endpoint", "$origin/authorize")
                    put("token_endpoint", "$origin/token")
                    put("device_authorization_endpoint", "$origin/device")
                    put("revocation_endpoint", "$origin/revoke")
                }))
                else -> answer(exchange, Said(500, buildJsonObject { put("error", "nothing scripted for $path") }))
            }
        }
        server.start()
    }

    fun of(path: String): List<Asked> = asked.filter { it.path == path }

    override fun close(): Unit = server.stop(0)
}

private fun jwt(claims: JsonObject): String {
    val encoded = Base64.getUrlEncoder().withoutPadding()
    return listOf("""{"alg":"RS256","typ":"JWT"}""", claims.toString()).joinToString(".") { encoded.encodeToString(it.toByteArray()) } + ".c2lnbmF0dXJl"
}

internal fun tokenFor(name: String, lifetimeSeconds: Long = 3600): String {
    val now = System.currentTimeMillis() / 1000
    return jwt(buildJsonObject {
        put("email", "alice@example.org")
        put("iss", "issuer")
        put("iat", now)
        put("exp", now + lifetimeSeconds)
        put("jti", name)
    })
}

internal fun issued(access: String, refresh: String? = null): Said = Said(200, buildJsonObject {
    put("access_token", access)
    put("token_type", "Bearer")
    refresh?.let { put("refresh_token", it) }
})

private fun error(code: String, status: Int = 400): Said = Said(status, buildJsonObject { put("error", code) })

/** The gateway's answer to `GET /api/users/me` for an agent's account: its DID, and no address, name or image. */
private fun named(did: String): Said = Said(200, buildJsonObject {
    put("did", did)
    put("email", JsonNull)
    put("name", JsonNull)
    put("image", JsonNull)
    put("domain", "kb.example")
})

private const val AGENT_DID = "did:web:kb.example:agents:worker"

/** Signing in at the issuer a knowledge base trusts, over the device grant, signing out, and a service and its agent signing in. */
class SignInTest {
    private val realms = mutableListOf<Realm>()

    private fun realm(trustsAnIssuer: Boolean = true) = Realm(trustsAnIssuer).also { realms += it }

    @AfterEach
    fun close() = realms.forEach { it.close() }

    private fun kb(realm: Realm): KbTarget {
        val port = realm.origin.substringAfterLast(':').toLong()
        return KbTarget(id = "local", label = "Local", endpoint = HttpEndpoint(host = "127.0.0.1", port = port, protocol = HttpEndpointProtocol.Http))
    }

    private val devicesCode = Said(200, buildJsonObject {
        put("device_code", "device-1")
        put("user_code", "ABCD-EFGH")
        put("verification_uri", "https://issuer.example/device")
        put("expires_in", 600)
        put("interval", 0)
    })

    @Test
    fun aDeviceSignInIsKeptOnceThePersonApproves() = runBlocking {
        val realm = realm()
        val access = tokenFor("access-1")
        realm.script("/device", devicesCode)
        realm.script("/token", error("authorization_pending"), error("slow_down"), issued(access, "refresh-1"))
        val kept = MemorySignIn()
        val shown = mutableListOf<String>()
        signInDevice(kb(realm), kept) { shown += it.userCode }
        assertEquals(listOf("ABCD-EFGH"), shown)
        assertEquals(HeldSignIn(access, "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", "${realm.origin}/revoke"), kept.held())
        assertEquals(listOf("device-1", "device-1", "device-1"), realm.of("/token").map { it.form.getValue("device_code") })
    }

    @Test
    fun aSignInDeniedAtTheIssuerIsTheSignInsFailure() = runBlocking {
        val realm = realm()
        realm.script("/device", devicesCode)
        realm.script("/token", error("access_denied"))
        val kept = MemorySignIn()
        val refused = assertThrows(SignInError::class.java) { runBlocking { signInDevice(kb(realm), kept) {} } }
        assertEquals(SignInErrorCode.Denied, refused.reason)
        assertNull(kept.held())
    }

    @Test
    fun aKnowledgeBaseThatTrustsNoIssuerHasNowhereToSignIn() = runBlocking {
        val refused = assertThrows(SignInError::class.java) { runBlocking { signInDevice(kb(realm(trustsAnIssuer = false)), MemorySignIn()) {} } }
        assertEquals(SignInErrorCode.NoIssuer, refused.reason)
    }

    @Test
    fun signingOutRevokesAtTheIssuerAndForgets() = runBlocking {
        val realm = realm()
        realm.script("/revoke", Said(200, JsonObject(emptyMap())))
        val kept = MemorySignIn(HeldSignIn(tokenFor("access-1"), "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", "${realm.origin}/revoke"))
        signOut(kept)
        assertEquals("refresh-1", realm.of("/revoke").single().form["token"])
        assertNull(kept.held())
    }

    @Test
    fun aSignOutTheIssuerRefusesStillForgets() = runBlocking {
        val realm = realm()
        realm.script("/revoke", error("server_error", 500))
        val kept = MemorySignIn(HeldSignIn(tokenFor("access-1"), "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", "${realm.origin}/revoke"))
        signOut(kept)
        assertNull(kept.held())
    }

    @Test
    fun aServiceTokenIsFetchedOnceAndKeptUntilItIsDue() = runBlocking {
        val realm = realm()
        val service = tokenFor("service-1")
        realm.script("/token", issued(service))
        val token = ServiceToken(SecretCredential(realm.origin, "worker", "the-secret"))
        assertEquals("Bearer $service", token.authorization())
        assertEquals("Bearer $service", token.authorization())
        val grant = realm.of("/token").single().form
        assertEquals(mapOf("grant_type" to "client_credentials", "client_id" to "worker", "client_secret" to "the-secret"), grant)
    }

    @Test
    fun aRefusedGrantNamesTheClientAndNeverTheSecret() = runBlocking {
        val realm = realm()
        realm.script("/token", Said(401, buildJsonObject { put("error", "invalid_client"); put("echo", "the-secret") }))
        val refused = assertThrows(SignInError::class.java) { runBlocking { ServiceToken(SecretCredential(realm.origin, "worker", "the-secret")).authorization() } }
        assertEquals(401, refused.status)
        assertTrue(refused.message!!.contains("worker") && !refused.message!!.contains("the-secret"), refused.message)
        assertTrue(!SecretCredential(realm.origin, "worker", "the-secret").toString().contains("the-secret"))
    }

    @Test
    fun anAgentSignsInAsItsAccountAndIsGrantedAnotherTokenWhenItsTokenIsRefused() = runBlocking {
        val realm = realm()
        val first = tokenFor("service-1")
        val second = tokenFor("service-2")
        realm.script("/token", issued(first), issued(second))
        realm.script("/api/users/me", named(AGENT_DID))
        AgentToken(realm.origin, ServiceToken(SecretCredential(realm.origin, "worker", "the-secret"))).use { agent ->
            assertThrows(IllegalStateException::class.java) { agent.did }
            agent.signIn()
            // The bearer is the issuer's token, and the gateway names its account.
            assertEquals(UserId.parse(AGENT_DID), agent.did)
            assertEquals(first, agent.token.value)
            // A refused token is answered by a new grant, though the one held is not due, and the gateway is asked nothing more.
            assertEquals(second, agent.refresh(first))
            assertEquals(second, agent.token.value)
            assertEquals(2, realm.of("/token").size)
            assertEquals(listOf("Bearer $first"), realm.of("/api/users/me").map { it.authorization })
        }
    }

    // ── What fails, and how it is said ───────────────────────────────────

    private fun refusal(status: Int, error: String) = Said(status, buildJsonObject { put("error", error) })

    private suspend fun signInFails(realm: Realm): SignInError =
        assertThrows(SignInError::class.java) { runBlocking { signInDevice(kb(realm), MemorySignIn()) {} } }

    @Test
    fun anIssuerThatDescribesAnotherIsNoIssuerToSignInAt() = runBlocking {
        val realm = realm()
        realm.script("/.well-known/openid-configuration", Said(200, buildJsonObject { put("issuer", "https://elsewhere.example"); put("token_endpoint", "x"); put("authorization_endpoint", "y") }))
        assertEquals(SignInErrorCode.Discovery, signInFails(realm).reason)
    }

    @Test
    fun anIssuerWhoseDiscoveryFailsIsNoIssuerToSignInAt() = runBlocking {
        val realm = realm()
        realm.script("/.well-known/openid-configuration", refusal(503, "unavailable"))
        val failed = signInFails(realm)
        assertEquals(SignInErrorCode.Discovery to 503, failed.reason to failed.status)
    }

    @Test
    fun aKnowledgeBaseWhoseMetadataFailsSaysNothingOfItsIssuer() = runBlocking {
        val realm = realm()
        // A request the gateway answers 500 is made once more, as the transport rule says: both are refused.
        realm.script("/.well-known/oauth-protected-resource", refusal(500, "broken"), refusal(500, "broken"))
        assertEquals(SignInErrorCode.Discovery, signInFails(realm).reason)
    }

    @Test
    fun anIssuerWithNoDeviceEndpointHasNoDeviceGrant() = runBlocking {
        val realm = realm()
        realm.script("/.well-known/openid-configuration", Said(200, buildJsonObject { put("issuer", realm.origin); put("token_endpoint", "${realm.origin}/token"); put("authorization_endpoint", "${realm.origin}/authorize") }))
        val failed = signInFails(realm)
        assertEquals(SignInErrorCode.Discovery, failed.reason)
        assertTrue(failed.message!!.contains("device"), failed.message)
    }

    @Test
    fun aRefusedDeviceAuthorizationIsTheSignInsFailure() = runBlocking {
        val realm = realm()
        realm.script("/device", refusal(400, "invalid_client"))
        val failed = signInFails(realm)
        assertEquals(SignInErrorCode.Exchange to 400, failed.reason to failed.status)
        assertTrue(failed.message!!.contains("invalid_client"), failed.message)
    }

    @Test
    fun aCodeThatExpiresEndsTheSignIn() = runBlocking {
        val realm = realm()
        realm.script("/device", devicesCode)
        realm.script("/token", error("expired_token"))
        assertEquals(SignInErrorCode.Expired, signInFails(realm).reason)
    }

    @Test
    fun anAnswerTheGrantDoesNotKnowEndsTheSignIn() = runBlocking {
        val realm = realm()
        realm.script("/device", devicesCode)
        realm.script("/token", error("invalid_grant"))
        assertEquals(SignInErrorCode.Exchange, signInFails(realm).reason)
    }

    @Test
    fun tokensWithNoRefreshTokenAreNoSignInToKeep() = runBlocking {
        val realm = realm()
        realm.script("/device", devicesCode)
        realm.script("/token", issued(tokenFor("access-1")))
        val failed = signInFails(realm)
        assertEquals(SignInErrorCode.Exchange, failed.reason)
        assertTrue(failed.message!!.contains("no refresh token"), failed.message)
    }

    private fun kept(realm: Realm, access: String) = MemorySignIn(HeldSignIn(access, "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null))

    @Test
    fun aRenewalTheIssuerRefusesOutrightSaysSoInItsWords() = runBlocking {
        val realm = realm()
        realm.script("/token", Said(400, buildJsonObject { put("error", "invalid_grant"); put("error_description", "the refresh token was revoked") }))
        val failed = assertThrows(SignInError::class.java) { runBlocking { renewKept(kept(realm, tokenFor("access-1")), tokenFor("access-1")) } }
        assertEquals(400, failed.status)
        assertTrue(failed.message!!.contains("invalid_grant: the refresh token was revoked"), failed.message)
    }

    @Test
    fun aRenewalTheIssuerNeverAnswersIsTriedWithinItsBudgetAndSaysHowOften() = runBlocking {
        val realm = realm()
        repeat(4) { realm.script("/token", refusal(503, "unavailable")) }
        val access = tokenFor("access-1")
        val failed = assertThrows(SignInError::class.java) { runBlocking { renewKept(kept(realm, access), access) } }
        assertEquals(4, realm.of("/token").size)
        assertTrue(failed.message!!.contains("after 4 attempts"), failed.message)
    }

    @Test
    fun aServiceWhoseIssuerFailsDiscoveryIsNotSignedIn() = runBlocking {
        val realm = realm()
        realm.script("/.well-known/openid-configuration", refusal(502, "bad gateway"))
        val failed = assertThrows(SignInError::class.java) { runBlocking { ServiceToken(SecretCredential(realm.origin, "worker", "s")).authorization() } }
        assertEquals(SignInErrorCode.Discovery to 502, failed.reason to failed.status)
    }

    @Test
    fun aGrantThatIssuesNoTokenIsNoSignIn() = runBlocking {
        val realm = realm()
        realm.script("/token", Said(200, buildJsonObject { put("token_type", "Bearer") }))
        val failed = assertThrows(SignInError::class.java) { runBlocking { ServiceToken(SecretCredential(realm.origin, "worker", "s")).authorization() } }
        assertEquals(SignInErrorCode.Exchange, failed.reason)
    }

    @Test
    fun aTokenThatSaysNoExpiryIsKeptForTheLifetimeItsGrantStated() = runBlocking {
        val realm = realm()
        realm.script("/token", Said(200, buildJsonObject { put("access_token", "opaque-1"); put("expires_in", 3600) }))
        val token = ServiceToken(SecretCredential(realm.origin, "worker", "s"))
        assertEquals("Bearer opaque-1", token.authorization())
        assertEquals("Bearer opaque-1", token.authorizationFuture().get())
        assertEquals(1, realm.of("/token").size)
    }

    private fun agent(realm: Realm): AgentToken {
        realm.script("/token", issued(tokenFor("service-1")))
        return AgentToken(realm.origin, ServiceToken(SecretCredential(realm.origin, "worker", "s")))
    }

    @Test
    fun aGatewayThatRefusesTheAgentsTokenIsTheAgentsFailure() = runBlocking {
        val realm = realm()
        realm.script("/api/users/me", Said(401, buildJsonObject { put("error", "unauthorized") }))
        agent(realm).use { agent ->
            val failed = assertThrows(semiont.errors.TransportError::class.java) { runBlocking { agent.signIn() } }
            assertEquals(401, failed.status)
        }
    }

    @Test
    fun aGatewayThatDoesNotSayWhoTheAgentIsSaysSoAndNothingOfTheAnswer() = runBlocking {
        val realm = realm()
        realm.script("/api/users/me", Said(200, buildJsonObject { put("secret", "not-a-principal") }))
        agent(realm).use { agent ->
            val failed = assertThrows(semiont.errors.TransportError::class.java) { runBlocking { agent.signIn() } }
            assertTrue(!failed.message!!.contains("not-a-principal"), failed.message)
        }
    }

    @Test
    fun anAgentWhoseAccountCannotSignInNeverAsksTheGateway() = runBlocking {
        val realm = realm()
        realm.script("/token", Said(401, buildJsonObject { put("error", "invalid_client") }))
        AgentToken(realm.origin, ServiceToken(SecretCredential(realm.origin, "worker", "s"))).use { agent ->
            val failed = assertThrows(SignInError::class.java) { runBlocking { agent.signIn() } }
            assertEquals(SignInErrorCode.Exchange to 401, failed.reason to failed.status)
        }
        assertEquals(emptyList<Asked>(), realm.of("/api/users/me"))
    }

    @Test
    fun anAgentWhoseRenewalFailsKeepsItsTokenAndSaysNone() = runBlocking {
        val realm = realm()
        realm.script("/api/users/me", named(AGENT_DID))
        agent(realm).use { agent ->
            realm.script("/token", Said(503, buildJsonObject { put("error", "down") }))
            agent.signInFuture().get()
            val held = agent.token.value
            assertNull(agent.refresh(held))
            assertEquals(held, agent.token.value)
        }
    }

    @Test
    fun aKeptSignInIsReachedFromJavaThroughFutures() {
        val kept = MemorySignIn()
        val held = HeldSignIn("access-1", "refresh-1", SCRIPT_CLIENT_ID, "https://issuer.example/token", null)
        kept.keepFuture(held).get()
        assertEquals(held, kept.heldFuture().get())
        assertEquals("access-2", kept.renewedFuture(held, "access-2", "refresh-2").get())
        kept.forgetFuture().get()
        assertNull(kept.heldFuture().get())
    }
}
