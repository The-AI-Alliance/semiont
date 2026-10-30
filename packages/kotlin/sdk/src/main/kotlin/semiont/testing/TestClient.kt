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
 * client closes it, and whoever made the transport closes that.
 */
public class TestClient internal constructor(
    public val transport: FaultyTransport,
    public val content: InMemoryContent,
    public val gateway: StubGateway,
    timing: ClientTiming,
    persistence: CachePersistence?,
    context: CoroutineContext,
    clock: TimeSource,
) {
    /** A client whose work runs on the default dispatcher. */
    @JvmOverloads
    public constructor(
        transport: FaultyTransport = FaultyTransport(),
        content: InMemoryContent = InMemoryContent(),
        gateway: StubGateway = StubGateway(),
        timing: ClientTiming = ClientTiming(),
        persistence: CachePersistence? = null,
    ) : this(transport, content, gateway, timing, persistence, Dispatchers.Default, TimeSource.Monotonic)

    /** The client, over the doubles. */
    public val client: SemiontClient = SemiontClient(transport, content, gateway, timing, persistence, context, clock)
}
