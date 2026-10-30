package semiont.testing

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import semiont.SemiontClient
import semiont.session.SemiontSession
import semiont.signin.MemorySignIn
import semiont.signin.SignInKept
import semiont.telemetry.futureOf
import semiont.types.HttpEndpoint
import semiont.types.HttpEndpointProtocol
import semiont.types.KbTarget
import java.util.concurrent.CompletableFuture

/** The knowledge base a test session is with, unless a test says another: `test-kb` at `http://localhost:4000`. */
private fun testKb(): KbTarget = KbTarget(id = "test-kb", label = "Test KB", endpoint = HttpEndpoint(host = "localhost", port = 4000, protocol = HttpEndpointProtocol.Http))

/**
 * What a test session is built over. What a test leaves out is made: a
 * `TestClient` of doubles that answer nothing, `test-kb` at
 * `http://localhost:4000`, and a `MemorySignIn` that holds none.
 */
public class TestSessionOptions @JvmOverloads constructor(
    /** The test client the session is over. */
    public val client: TestClient = TestClient(),
    /** The knowledge base the session is with. */
    public val kb: KbTarget = testKb(),
    /** Where the session's sign-in is kept: a sign-in kept there is the session's at its start. */
    public val kept: SignInKept = MemorySignIn(),
)

/** A session, and what it was built over. The token the session holds is the test's to set. */
public class TestSession internal constructor(
    public val session: SemiontSession,
    public val client: SemiontClient,
    public val transport: FaultyTransport,
    public val content: InMemoryContent,
    public val gateway: StubGateway,
    /** Where the session's sign-in is kept. */
    public val kept: SignInKept,
    private val tokens: MutableStateFlow<String?>,
) {
    /** Set the token the session holds, as a sign-in would: a test that needs a signed-in session sets one. */
    public fun setToken(token: String?) {
        tokens.value = token
    }
}

/**
 * A real `SemiontSession` over a test client, started: it renews nothing and
 * asks nobody who it is, so it is ready as soon as it has read where its
 * sign-in is kept, and holds a token only if one was kept there. It only uses
 * its client: the caller ends the session and then the client, and whoever
 * made the transport closes it.
 */
public suspend fun createTestSession(options: TestSessionOptions): TestSession {
    val made = options.client
    val tokens = MutableStateFlow<String?>(null)
    val session = SemiontSession(options.kb, made.client, tokens, options.kept, null, null, null, null)
    session.start()
    return TestSession(session, made.client, made.transport, made.content, made.gateway, options.kept, tokens)
}

/** `createTestSession`, for Java. */
public fun createTestSessionFuture(options: TestSessionOptions): CompletableFuture<TestSession> =
    CoroutineScope(Dispatchers.Default).futureOf { createTestSession(options) }
