package semiont.testing

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Test
import semiont.session.token
import semiont.signin.HeldSignIn
import semiont.signin.MemorySignIn
import semiont.types.HttpEndpoint
import semiont.types.HttpEndpointProtocol
import semiont.types.KbTarget

/** A real session over a test client: ready at once, holding a token only if one was kept, and the test's to sign in. */
class TestSessionTest {
    @Test
    fun aTestSessionIsReadyAtOnceAndSignedInAsNobodyUntilTheTestSetsAToken() = runBlocking {
        val made = createTestSession(TestSessionOptions())
        withTimeout(5_000) { made.session.ready() }
        assertSame(made.client, made.session.client)
        assertSame(made.transport, made.client.transport)
        assertEquals("test-kb", made.session.kb.id)
        assertEquals(null to null, made.session.token.value to made.session.user.value)
        made.setToken("a-token")
        assertEquals("a-token", made.session.token.value)
        made.session.close()
        made.client.close()
        made.transport.close()
    }

    @Test
    fun aTestSessionIsBuiltOverWhatItIsGivenAndASignInKeptThereIsItsAtItsStart() = runBlocking {
        val client = TestClient()
        val kb = KbTarget(id = "kb-2", label = "Another", endpoint = HttpEndpoint(host = "example.org", port = 443, protocol = HttpEndpointProtocol.Https))
        val access = token(3600, 1)
        val kept = MemorySignIn(HeldSignIn(access, "a-refresh-token", "semiont-cli", "https://issuer.test/token", null))
        val given = createTestSession(TestSessionOptions(client, kb, kept))
        withTimeout(5_000) { given.session.ready() }
        assertSame(client.client, given.client)
        assertSame(client.content, given.content)
        assertSame(client.gateway, given.gateway)
        assertSame(kept, given.kept)
        assertEquals(kb to access, given.session.kb to given.session.token.value)
        assertNull(given.session.user.value, "nobody is asked who it is")
        given.session.close()
        given.client.close()
        given.transport.close()
    }
}
