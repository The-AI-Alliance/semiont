package semiont.http

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import semiont.errors.SessionError
import semiont.errors.SessionErrorCode
import semiont.signin.HeldSignIn
import semiont.signin.MemorySignIn
import semiont.signin.SCRIPT_CLIENT_ID
import semiont.types.HttpEndpoint
import semiont.types.HttpEndpointProtocol
import semiont.types.KbTarget
import semiont.types.LocalEndpoint

private val alice = Json.parseToJsonElement(
    """{"did":"did:web:example.org:users:alice","email":"alice@example.org","name":"Alice","image":null,"domain":"example.org","isAdmin":false,"isModerator":false,"termsAcceptedAt":null}""",
).jsonObject

private val refused = buildJsonObject { put("error", "invalid_token") }

/** A session over HTTP from a kept sign-in: opened, renewed through itself, and closed with what it opened. */
class SessionFromKeptTest {
    private fun kb(realm: Realm) = KbTarget(id = "local", label = "Local", endpoint = HttpEndpoint(host = "127.0.0.1", port = realm.origin.substringAfterLast(':').toLong(), protocol = HttpEndpointProtocol.Http))

    @Test
    fun aTokenTheGatewayRefusesAsTheSessionStartsIsRenewedThroughTheSession() = runBlocking {
        Realm().use { realm ->
            val stored = tokenFor("access-1")
            val renewed = tokenFor("access-2")
            // The stream and the ask are both refused the kept token; each is answered by the session's one renewal.
            realm.script("/bus/subscribe", Said(401, refused))
            realm.script("/api/users/me", Said(401, refused), Said(200, alice))
            realm.script("/token", issued(renewed, "refresh-2"))
            val kept = MemorySignIn(HeldSignIn(stored, "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null))
            sessionFromKept(kb(realm), kept).use { opened ->
                assertEquals(renewed, opened.session.token.value)
                assertEquals("alice@example.org", opened.session.user.value?.email)
                assertEquals(listOf("refresh-1"), realm.of("/token").map { it.form["refresh_token"] })
                assertEquals(renewed, kept.held()?.access)
            }
        }
    }

    @Test
    fun aRefusalOfTheStreamBeforeTheSessionExistsIsRenewedByTheSession() = runBlocking {
        Realm().use { realm ->
            val stored = tokenFor("access-1")
            val renewed = tokenFor("access-2")
            // The gateway knows who the kept token is, and its stream refuses it: only the transport's refresher, which
            // the stream asks before the session it refreshes through exists, renews it.
            realm.script("/bus/subscribe", Said(401, refused))
            realm.script("/api/users/me", Said(200, alice), Said(200, alice))
            realm.script("/token", issued(renewed, "refresh-2"))
            val kept = MemorySignIn(HeldSignIn(stored, "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null))
            sessionFromKept(kb(realm), kept).use { opened ->
                withTimeout(10_000) { opened.session.token.first { it == renewed } }
                assertEquals(listOf("refresh-1"), realm.of("/token").map { it.form["refresh_token"] })
            }
        }
    }

    @Test
    fun withNothingKeptTheSessionIsSignedOut() = runBlocking {
        Realm().use { realm ->
            sessionFromKept(kb(realm), MemorySignIn()).use { opened ->
                assertNull(opened.session.token.value)
                assertEquals(emptyList<Asked>(), realm.of("/api/users/me"))
            }
        }
    }

    @Test
    fun aKnowledgeBaseReachedOtherwiseThanOverHttpHasNoSessionOverIt() {
        val local = KbTarget(id = "here", label = "Here", endpoint = LocalEndpoint(kbId = "here"))
        val refusal = assertThrows(SessionError::class.java) { runBlocking { sessionFromKept(local, MemorySignIn()) } }
        assertEquals(SessionErrorCode.ConstructFailed, refusal.reason)
    }
}
