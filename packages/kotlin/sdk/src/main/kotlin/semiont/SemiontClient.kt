package semiont

import semiont.bus.Bus
import semiont.bus.EventBus
import semiont.namespaces.AuthNamespace
import semiont.namespaces.BeckonNamespace
import semiont.namespaces.BindNamespace
import semiont.namespaces.BrowseNamespace
import semiont.namespaces.FrameNamespace
import semiont.namespaces.GatherNamespace
import semiont.namespaces.JobNamespace
import semiont.namespaces.Links
import semiont.namespaces.Live
import semiont.namespaces.Refresher
import semiont.namespaces.MarkNamespace
import semiont.namespaces.MatchNamespace
import semiont.namespaces.SystemNamespace
import semiont.namespaces.YieldNamespace
import semiont.transport.ContentTransport
import semiont.transport.GatewayOperations
import semiont.transport.Transport

/**
 * A client of one knowledge base: its namespaces, each a verb of the protocol,
 * over `transport`. `content` carries the bytes and `gateway` answers for
 * itself; over HTTP the transport is all three. `transport` is kept for what
 * the namespaces do not cover: a frame on a channel by name, a hold on a
 * resource's scope. Closing it ends what it runs and its own bus; it never
 * closes its transport, which is whoever made it's to close.
 */
public class SemiontClient @JvmOverloads constructor(
    public val transport: Transport,
    content: ContentTransport,
    gateway: GatewayOperations,
    public val timing: ClientTiming = ClientTiming(),
) : AutoCloseable {
    /** The client's own bus: every frame the transport delivered, and every signal the client's parts gave each other. */
    public val bus: EventBus = EventBus()

    /** The bus over the transport, typed by channel: an emit, a channel's frames, a request. */
    public val wire: Bus

    internal val links: Links

    /** The caches the client's live queries answer from, and what keeps them true. */
    private val live: Live
    private val refresher: Refresher

    init {
        wire = Bus(transport)
        links = Links(transport, wire, bus, timing)
        transport.bridgeInto(bus)
        live = Live(links, content)
        refresher = Refresher(links, live)
        refresher.start()
    }

    /** The vocabulary: what kinds of things exist. */
    public val frame: FrameNamespace = FrameNamespace(links)

    /** Reads, and this viewer's own signals. */
    public val browse: BrowseNamespace = BrowseNamespace(links, content, live)

    /** Annotations, a resource's own metadata, and the annotating of a resource delegated as a job. */
    public val mark: MarkNamespace = MarkNamespace(links)

    /** Linking a reference to what it refers to. */
    public val bind: BindNamespace = BindNamespace(links)

    /** Assembling the context a model is given, and what refers to a resource. */
    public val gather: GatherNamespace = GatherNamespace(links, live)

    /** Searching: for what a reference could refer to, and for resources by text. */
    public val match: MatchNamespace = MatchNamespace(links, live)

    /** Creating resources. `yield` is no keyword in Kotlin; Java calls it as a member, which its contextual `yield` does not touch. */
    public val yield: YieldNamespace = YieldNamespace(links, content)

    /** Attention: driving the other participants' viewers. */
    public val beckon: BeckonNamespace = BeckonNamespace(links)

    /** Jobs: their lifecycle, their status and their cancellation. */
    public val job: JobNamespace = JobNamespace(links)

    /** The gateway's view of who is signed in. */
    public val auth: AuthNamespace = AuthNamespace(links, gateway)

    /** What the knowledge base says about itself. */
    public val system: SystemNamespace = SystemNamespace(links, gateway)

    /**
     * End the client: its live queries end, so every collector of one does, and
     * its own bus, so every reader of it does, and then the work it began.
     * Closing twice is closing once.
     */
    override fun close() {
        refresher.dispose()
        live.dispose()
        bus.destroy()
        links.close()
    }
}
