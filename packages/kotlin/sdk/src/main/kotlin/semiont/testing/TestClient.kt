package semiont.testing

import kotlinx.coroutines.Dispatchers
import semiont.ClientTiming
import semiont.SemiontClient
import semiont.storage.CachePersistence
import kotlin.coroutines.CoroutineContext
import kotlin.time.TimeSource

/**
 * A real `SemiontClient` over doubles: its namespaces, its caches and its
 * deadlines are the client's own, and only what it speaks through is a
 * double. A test scripts the doubles (`transport`, `content`, `gateway`) and
 * observes through the client. A double a test does not give is one that
 * nothing is scripted to answer and that holds nothing. Whoever made the
 * client closes it, and whoever made the transport closes that. The client's
 * work runs on `context`, and its waits keep `clock`; a transport it makes
 * itself delivers on `context` too.
 */
public class TestClient @JvmOverloads constructor(
    context: CoroutineContext = Dispatchers.Default,
    clock: TimeSource = TimeSource.Monotonic,
    public val transport: FaultyTransport = FaultyTransport(context = context),
    public val content: InMemoryContent = InMemoryContent(),
    public val gateway: StubGateway = StubGateway(),
    timing: ClientTiming = ClientTiming(),
    persistence: CachePersistence? = null,
) {

    /** The client, over the doubles. */
    public val client: SemiontClient = SemiontClient(transport, content, gateway, timing, persistence, context, clock)
}
