package semiont

import kotlinx.coroutines.Dispatchers
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
import semiont.storage.CachePersistence
import semiont.storage.CoupledBookmarks
import semiont.namespaces.MarkNamespace
import semiont.namespaces.MatchNamespace
import semiont.namespaces.SystemNamespace
import semiont.namespaces.YieldNamespace
import semiont.transport.ContentTransport
import semiont.transport.GatewayOperations
import semiont.transport.Transport
import kotlin.coroutines.CoroutineContext
import kotlin.time.TimeSource

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
    /** Where the client keeps what its queries hold, so the next client of the same knowledge base shows it at once: nowhere, when none. */
    persistence: CachePersistence? = null,
    /** Where the client's work runs, under the job it has when it has one. */
    context: CoroutineContext = Dispatchers.Default,
    /** The time `context`'s waits keep. */
    clock: TimeSource = TimeSource.Monotonic,
) : AutoCloseable {

    /** The client's own bus: every frame the transport delivered, and every signal the client's parts gave each other. */
    public val bus: EventBus = EventBus()

    /** The bus over the transport, typed by channel: an emit, a channel's frames, a request. */
    public val wire: Bus

    internal val links: Links

    /** The caches the client's live queries answer from, and what keeps them true. */
    private val live: Live
    private val refresher: Refresher

    /**
     * Where the stream's places are kept beside what the client keeps, written
     * while it is settled and as it closes: nowhere, until places are coupled
     * to it (`CoupledBookmarks.coupleTo`). Its refresher remembers a recorded
     * event's place there once it has taken the event.
     */
    @Volatile
    internal var places: CoupledBookmarks? = null

    /**
     * What makes the caches' writes of what the client keeps, later than they
     * save: given by a session, whose writer makes each write in its turn and
     * keeps a write the storage refused until it is made. None for a client
     * whose caches write their storage themselves, and hear each refusal.
     */
    @Volatile
    internal var writes: KeptWrites? = null

    init {
        wire = Bus(transport, context, clock)
        links = Links(transport, wire, bus, timing, context, clock)
        transport.bridgeInto(bus)
        live = Live(links, content, persistence)
        refresher = Refresher(links, live) { taken -> places?.save(taken.scope, taken.eventId) }
        refresher.start()
    }

    /**
     * Whether the stream's place may be kept beside what the client keeps: no
     * query it keeps is being fetched or is owed to storage, no event's
     * refetch is owed, and no write the storage refused is owed
     * (protocol/contract/CACHE-SEMANTICS.md, B17 and B19).
     */
    public val persistenceSettled: Boolean
        // What is owed a refetch is read before the caches: a refetch a closing window starts is owed until its fetch is in flight.
        get() = !refresher.owesARefetch && live.persistenceSettled && !owesARefusedWrite

    /** Whether a write the storage refused has not been made since (`writes`). */
    internal val owesARefusedWrite: Boolean get() = writes?.owesARefusedWrite == true

    /** Keep what the client's queries hold in `persistence` from now on: what a client made keeping nothing is given once the person it is for is known. */
    internal fun attach(persistence: CachePersistence): Unit = live.attach(persistence)

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
     * End the client: its live queries end, so every collector of one does,
     * each making the save it owes, and then each write the storage refused
     * before the close began, and not made since, is made once more: its
     * closing flush, which makes each write once. One the storage refuses is
     * said, and lost with the client. Then its own bus ends, so every reader
     * of it does, and then the work it began. Closing twice is closing once.
     */
    override fun close() {
        writes?.beginClosing()
        // Read once, before anything is closed, in one step with the places closing may write: closing drops a fetch in
        // flight and a refetch owed, so either holds them back; a save owed does not, since closing's flush is the save. The
        // refetch is read first, as `persistenceSettled` reads it.
        places?.freeze { !refresher.owesARefetch && live.keptFetchesSettled }
        refresher.dispose()
        live.dispose()
        writes?.writeRefused()
        bus.destroy()
        links.close()
    }

    /** Wait until the writes the closing flush began have been made or refused: none waits, for a client whose caches write their storage themselves. */
    internal suspend fun flushed() {
        writes?.landed()
    }
}

/**
 * A writer of what a client keeps that makes each of its caches' writes in
 * its turn, later than the cache saves: a session's, whose writes are made
 * only while its sign-in names the person they are for.
 */
internal interface KeptWrites {
    /** Whether a write the storage refused has not been made since: until a write of its key is made, which the closing flush may be. */
    val owesARefusedWrite: Boolean

    /** The client begins to close, in its turn among the writes: from then on, a write the storage refuses is said, and lost with the client. */
    fun beginClosing()

    /** Make each write the storage refused before the client began to close, and has not been made since, in turn: the last of the client's closing flush. */
    fun writeRefused()

    /** Wait until every write begun so far has been made or refused. */
    suspend fun landed()
}
