package semiont.http

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
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
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.URLDecoder
import java.util.Base64
import java.util.concurrent.ConcurrentLinkedDeque
import java.util.concurrent.CopyOnWriteArrayList

/** One answer of the fake: its status and its JSON body. */
internal class Said(val status: Int, val body: JsonObject)

/** One request the fake was asked: its method, path, headers and form. */
internal class Asked(val method: String, val path: String, val authorization: String?, val form: Map<String, String>)

/** A knowledge base's gateway and the issuer it trusts, in one server, answering each path with what a test gives it. */
internal class Realm(trustsAnIssuer: Boolean = true) : AutoCloseable {
    private val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
    val origin: String = "http://127.0.0.1:${server.address.port}"
    val asked = CopyOnWriteArrayList<Asked>()
    val scripted = mutableMapOf<String, ConcurrentLinkedDeque<Said>>()

    fun script(path: String, vararg said: Said) {
        scripted.getOrPut(path) { ConcurrentLinkedDeque() }.addAll(said)
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
            val form = if (text.contains('=') && !text.startsWith("{")) {
                text.split('&').associate { pair -> pair.split('=', limit = 2).let { URLDecoder.decode(it[0], Charsets.UTF_8) to URLDecoder.decode(it[1], Charsets.UTF_8) } }
            } else {
                emptyMap()
            }
            val path = exchange.requestURI.path
            asked += Asked(exchange.requestMethod, path, exchange.requestHeaders.getFirst("Authorization"), form)
            when {
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
                else -> answer(exchange, scripted[path]?.pollFirst() ?: Said(500, buildJsonObject { put("error", "nothing scripted for $path") }))
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
    fun anAgentIsSignedInAsTheGatewayNamesItAndExchangesAgainWhenItsTokenIsRefused() = runBlocking {
        val realm = realm()
        val service = tokenFor("service-1")
        realm.script("/token", issued(service))
        val did = "did:web:kb.example:agents:anthropic:claude"
        realm.script("/api/tokens/agent", Said(200, buildJsonObject { put("token", "agent-1"); put("did", did) }), Said(200, buildJsonObject { put("token", "agent-2"); put("did", did) }))
        AgentToken(realm.origin, "anthropic", "claude", ServiceToken(SecretCredential(realm.origin, "worker", "the-secret"))).use { agent ->
            assertThrows(IllegalStateException::class.java) { agent.did }
            agent.signIn()
            assertEquals(UserId.parse(did), agent.did)
            assertEquals("agent-1", agent.token.value)
            assertEquals("agent-2", agent.refresh("agent-1"))
            assertEquals("agent-2", agent.token.value)
            assertEquals(listOf("Bearer $service", "Bearer $service"), realm.of("/api/tokens/agent").map { it.authorization })
        }
    }
}
