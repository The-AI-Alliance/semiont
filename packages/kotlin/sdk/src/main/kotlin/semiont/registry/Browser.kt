@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.registry

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import semiont.bus.EventBus
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode
import semiont.errors.SemiontError
import semiont.errors.SessionError
import semiont.errors.SessionErrorCode
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.identifiers.ResourceId
import semiont.identity.kbDid
import semiont.resources.primaryMediaType
import semiont.session.KbIdentityConflict
import semiont.session.OpenedSession
import semiont.session.SemiontSession
import semiont.session.SessionSignals
import semiont.session.isTokenExpired
import semiont.storage.SessionStorage
import semiont.telemetry.futureOf
import semiont.transport.Broadcast
import semiont.transport.Events
import semiont.transport.Variable
import semiont.transport.Watched
import semiont.types.HttpEndpoint
import semiont.types.KbDescription
import semiont.types.KbEndpoint
import semiont.types.KbRead
import semiont.types.KnowledgeBase
import semiont.types.LocalEndpoint
import semiont.types.NewKnowledgeBase
import semiont.types.wireJson
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.UUID
import java.util.concurrent.CompletableFuture

/**
 * What a completed sign-in learned: where it was, who the knowledge base
 * there says it is, the tokens, and what the person believed they were
 * signing in to.
 */
public data class SignedIn @JvmOverloads constructor(
    public val endpoint: KbEndpoint,
    /** What the knowledge base said of itself, asked with the new token. */
    public val description: KbDescription,
    public val session: StoredSession,
    /** The registered entry the person re-authenticated; null when it was none. */
    public val kbId: String? = null,
    /** The did of a row the person clicked; null when it was none. */
    public val expectedDid: String? = null,
    /** The name of a row the person clicked; null when it was none. */
    public val expectedName: String? = null,
)

/** What a person believed they were signing in to. `name` is null when nothing was named. */
public data class Expected(public val did: String, public val name: String?)

/**
 * The entry a sign-in landed on, and what the person believed: null when they
 * named nothing. A host sets the two against each other and says when they
 * differ. The sign-in stands either way: the knowledge base that answered is
 * the one reached.
 */
public data class SignInOutcome(public val kb: KnowledgeBase, public val expected: Expected?)

/**
 * What a knowledge base said when it was asked to describe itself, read
 * against the entry it was asked as: it answered as that entry, and its name
 * and branch are on it now; a different knowledge base answered, whose did and
 * name are on the verdict and nowhere else; or it did not answer, or could not
 * say who it is, which is evidence of nothing.
 */
public enum class KbReadKind(
    /** The kind as every SDK spells it. */
    public val wire: String,
) {
    Recorded("recorded"),
    Conflict("conflict"),
    NoVerdict("no-verdict"),
}

/** One reading of a knowledge base against its entry. `observedDid` and `observedName` are a `Conflict`'s alone: the knowledge base that answered. */
public data class KbReadVerdict @JvmOverloads constructor(
    public val kind: KbReadKind,
    public val observedDid: String? = null,
    public val observedName: String? = null,
)

/** How many open resources are checked at once when a session comes up: a connection just opened is not handed every check together. */
private const val CHECKS_AT_ONCE = 4

private val OPEN_BY_KB = MapSerializer(String.serializer(), ListSerializer(OpenResource.serializer()))

private val VIEWED_BY_KB = MapSerializer(String.serializer(), ResourceId.serializer())

private val NO_VERDICT = KbReadVerdict(KbReadKind.NoVerdict)

/** A time as RFC 3339, in UTC, to the millisecond, as every SDK writes what a knowledge base last said. */
private val AT = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

/** What is stored under one of the registry's keys, read; empty for what does not read as that. */
private fun <T> storedAs(serializer: KSerializer<Map<String, T>>, stored: String?): Map<String, T> = stored?.let {
    try {
        wireJson.decodeFromString(serializer, it)
    } catch (_: IllegalArgumentException) {
        null
    }
} ?: emptyMap()

/** Whether two endpoints are one place: for a gateway, its host and port; for a loaded knowledge base, its id. */
private fun samePlace(one: KbEndpoint, other: KbEndpoint): Boolean = when (one) {
    is HttpEndpoint -> other is HttpEndpoint && one.host == other.host && one.port == other.port
    is LocalEndpoint -> other is LocalEndpoint && one.kbId == other.kbId
}

/** What a knowledge base said of itself now, beyond its name. */
private fun readNow(description: KbDescription): KbRead = KbRead(AT.format(Instant.now()), description.gitBranch)

/** A factory's refusal as the failure a registry says: the factory's own when it is a session's. */
private fun constructFailed(refused: SemiontError, kbId: String): SessionError =
    refused as? SessionError ?: SessionError(SessionErrorCode.ConstructFailed, refused.message ?: refused.code, kbId)

/** One open resource's verdict. Asking for it freshly also puts what it answered in the client's cache, where a viewer reads it. */
private suspend fun checked(session: SemiontSession, resourceId: ResourceId): TabCheck = try {
    val descriptor = session.client.browse.resource(resourceId).fresh()
    TabCheck(TabVerdict.Ready, descriptor.name, primaryMediaType(descriptor))
} catch (refusal: BusRequestError) {
    TabCheck(if (refusal.reason == BusRequestErrorCode.NotFound) TabVerdict.Gone else TabVerdict.Unknown)
} catch (_: SemiontError) {
    // Anything else is a symptom, not a verdict.
    TabCheck(TabVerdict.Unknown)
}

/** A live session, and what a host is shown of it: closing it ends the routing of its failures, the session and what it was opened over, then the signals. */
private class Live(val opened: OpenedSession, val signals: SessionSignals, val routing: Job) {
    fun close() {
        routing.cancel()
        opened.close()
        signals.close()
    }
}

/**
 * What an application holds beside its knowledge bases: a registry of them.
 * The list it has registered, which one is active, the active one's session,
 * and what a person has open in each. It builds sessions through the
 * `SessionFactory` it is given, and so knows nothing of how a knowledge base
 * is reached. Made, it begins: it brings up the active knowledge base's
 * session, and hears what another context writes of what is open.
 *
 * One session is live at a time, the active knowledge base's. Making another
 * active closes it first: its readers see no session, then the new one.
 * Activations take turns, and one that was overtaken while it waited does
 * nothing. `sessionActivating` is true while one is under way.
 *
 * Look up by address, verify by did. A sign-in lands on the entry, among those
 * at the address, whose did is the one the knowledge base reported, or on a
 * new entry. What a person believed is reported back, never acted on, so an
 * entry's did never changes.
 *
 * What is open is per knowledge base, and shown only while it has a live
 * session. When a session comes up the knowledge base is asked who it is and
 * each open resource is checked against it: a resource it says does not exist
 * is closed; a different knowledge base answering voids what was open and
 * where the person was, and raises the conflict on the session's signals; no
 * answer changes nothing. Every change to what is open is made against what
 * the storage holds, as one step, so two contexts that each open a resource
 * both keep theirs.
 *
 * A request the gateway refuses for want of a valid token renews the session;
 * one refused for lack of permission is said at once. Closing the registry
 * closes its session and ends everything it holds.
 */
public class SemiontBrowser(config: SemiontBrowserConfig) : AutoCloseable {
    /** Where the registry keeps what it keeps: what a sign-in that is under way is remembered in, too. */
    public val storage: SessionStorage = config.storage

    private val factory = config.sessionFactory
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val lock = Any()

    /** One activation at a time: an activation that waits its turn waits here. */
    private val turn = Mutex()

    @Volatile
    private var closing = false

    private val kbsHeld = Variable<List<KnowledgeBase>>(emptyList())
    private val activeKbIdHeld = Variable<String?>(null)
    private val activeSessionHeld = Variable<SemiontSession?>(null)
    private val activeSignalsHeld = Variable<SessionSignals?>(null)
    private val activatingHeld = Variable(false)
    private val openResourcesHeld = Variable<List<OpenResource>>(emptyList())
    private val lastViewedHeld = Variable<ResourceId?>(null)
    private val identityTokenHeld = Variable<String?>(null)
    private val failures = Broadcast<SessionError>(keepForFirst = true)
    private var openByKb: Map<String, List<OpenResource>> = storedAs(OPEN_BY_KB, storage.get(OPEN_RESOURCES_BY_KB_KEY))
    private var viewedByKb: Map<String, ResourceId> = storedAs(VIEWED_BY_KB, storage.get(LAST_VIEWED_RESOURCE_BY_KB_KEY))
    private var activations = 0
    private var live: Live? = null

    /** The registered knowledge bases. */
    public val kbs: Watched<List<KnowledgeBase>> = kbsHeld.reading()

    /** The id of the active knowledge base; null for none. It names the one meant: its session may still be on its way, or there may be none. */
    public val activeKbId: Watched<String?> = activeKbIdHeld.reading()

    /** The active knowledge base's session; null when it has none. */
    public val activeSession: Watched<SemiontSession?> = activeSessionHeld.reading()

    /** What a host shows about the active session: there exactly when the session is. */
    public val activeSignals: Watched<SessionSignals?> = activeSignalsHeld.reading()

    /** Whether a session is being brought up. */
    public val sessionActivating: Watched<Boolean> = activatingHeld.reading()

    /** What is open in the active knowledge base, in order. Empty while it has no live session. */
    public val openResources: Watched<List<OpenResource>> = openResourcesHeld.reading()

    /** The resource last viewed in the active knowledge base; null while it has no live session, and never another knowledge base's. */
    public val lastViewedResource: Watched<ResourceId?> = lastViewedHeld.reading()

    /** The token of an identity the host's environment supplies; null for none. */
    public val identityToken: Watched<String?> = identityTokenHeld.reading()

    /** The application's own bus: what its parts say to each other whether or not a knowledge base is active, apart from a client's own bus. */
    public val bus: EventBus = EventBus()

    private val listening: AutoCloseable?

    init {
        // What was read is what is kept: an entry that did not read as a knowledge base is gone from the storage too.
        val read = loadKnowledgeBases(storage)
        val stated = storage.get(ACTIVE_KEY)
        val active = if (read.any { it.id == stated }) stated else read.firstOrNull()?.id
        putKbs(read)
        putActiveId(active)
        listening = storage.subscribe(::writtenElsewhere)
        if (active != null) scope.launch { setActive(active) }
    }

    /** The failures that made a session unusable, from now on, until the registry is closed. */
    public fun errors(): Events<SessionError> = failures.listen()

    /** Set the identity token; null for none. */
    public fun setIdentityToken(token: String?): Unit = identityTokenHeld.set(token)

    // The knowledge bases.

    /** Register a knowledge base that a sign-in reached, keep its tokens, and make it the active one. Returns once its session is up, or known not to be. */
    public suspend fun addKb(kb: NewKnowledgeBase, session: StoredSession): KnowledgeBase {
        val added = KnowledgeBase(UUID.randomUUID().toString(), kb.label, kb.endpoint, kb.did, kb.lastRead)
        storeSession(storage, added.id, session)
        synchronized(lock) { putKbs(kbsHeld.value + added) }
        setActive(added.id)
        return added
    }

    /** `addKb`, for Java. */
    public fun addKbFuture(kb: NewKnowledgeBase, session: StoredSession): CompletableFuture<KnowledgeBase> = scope.futureOf { addKb(kb, session) }

    /** Forget a knowledge base: its entry, its tokens, what was open in it and where the person was. If it was active, the first of the others becomes active. */
    public suspend fun removeKb(kbId: String) {
        clearStoredSession(storage, kbId)
        forgetKeptOf(kbId)
        val rest = synchronized(lock) { kbsHeld.value.filter { it.id != kbId }.also(::putKbs) }
        if (activeKbIdHeld.value == kbId) setActive(rest.firstOrNull()?.id)
    }

    /** `removeKb`, for Java. */
    public fun removeKbFuture(kbId: String): CompletableFuture<Unit> = scope.futureOf { removeKb(kbId) }

    /** Write what a knowledge base last said of itself onto its entry: a label, and a last read, each unless it is null. Its endpoint is not changed in place, and its did is never changed. */
    @JvmOverloads
    public fun updateKb(kbId: String, label: String? = null, lastRead: KbRead? = null): Unit = synchronized(lock) {
        putKbs(kbsHeld.value.map { if (it.id != kbId) it else it.copy(label = label ?: it.label, lastRead = lastRead ?: it.lastRead) })
    }

    /** What the credential stored for a knowledge base says, read without asking anyone. */
    public fun kbSessionStatus(kbId: String): KbSessionStatus {
        val stored = storedSession(storage, kbId) ?: return KbSessionStatus.SignedOut
        return if (isTokenExpired(stored.access, System.currentTimeMillis() / 1000.0)) KbSessionStatus.Expired else KbSessionStatus.Authenticated
    }

    /** Make a knowledge base the active one, or none. Returns once its session is up, or once it is known there will be none. */
    public suspend fun setActiveKb(kbId: String?): Unit = setActive(kbId)

    /** `setActiveKb`, for Java. */
    public fun setActiveKbFuture(kbId: String?): CompletableFuture<Unit> = scope.futureOf { setActive(kbId) }

    /** Keep new tokens for a registered knowledge base and bring its session up on them. A session it already had is closed and replaced. */
    public suspend fun signIn(kbId: String, session: StoredSession) {
        if (closing) return
        storeSession(storage, kbId, session)
        // A session it already has is on the old tokens: it is closed, and the one built next reads the new ones.
        if (activeKbIdHeld.value == kbId) takeSession()?.close()
        setActive(kbId)
    }

    /** `signIn`, for Java. */
    public fun signInFuture(kbId: String, session: StoredSession): CompletableFuture<Unit> = scope.futureOf { signIn(kbId, session) }

    /**
     * The registry's half of a sign-in: land it on the entry, among those at
     * its address, whose did the knowledge base reported, or on a new entry,
     * and make it active. Throws `IllegalArgumentException` for a description
     * whose domain no did can hold, and nothing is registered.
     */
    public suspend fun signedIn(signedIn: SignedIn): SignInOutcome {
        val did = kbDid(signedIn.description.domain).value
        val label = signedIn.description.name
        val lastRead = readNow(signedIn.description)
        val kbs = kbsHeld.value
        val atAddress = kbs.filter { samePlace(it.endpoint, signedIn.endpoint) }
        // An address with several entries singles out no belief of its own.
        val believed = when {
            signedIn.kbId != null -> kbs.firstOrNull { it.id == signedIn.kbId }
            atAddress.size == 1 -> atAddress.single()
            else -> null
        }
        val expected = when {
            signedIn.expectedDid != null -> Expected(signedIn.expectedDid, signedIn.expectedName)
            believed != null -> Expected(believed.did, believed.label)
            else -> null
        }
        val answered = atAddress.firstOrNull { it.did == did }
        if (answered != null) {
            updateKb(answered.id, label, lastRead)
            val landed = kbsHeld.value.first { it.id == answered.id }
            signIn(answered.id, signedIn.session)
            return SignInOutcome(landed, expected)
        }
        val added = addKb(NewKnowledgeBase(label, signedIn.endpoint, did, lastRead), signedIn.session)
        return SignInOutcome(added, expected)
    }

    /** `signedIn`, for Java. */
    public fun signedInFuture(signedIn: SignedIn): CompletableFuture<SignInOutcome> = scope.futureOf { signedIn(signedIn) }

    /** Sign out of a knowledge base: its tokens are forgotten, and the issuer is told so its refresh token is good for nothing. If it is active, its session is closed. */
    public suspend fun signOut(kbId: String) {
        if (closing) return
        val stored = storedSession(storage, kbId)
        clearStoredSession(storage, kbId)
        // The sign-out is the local act: an issuer that cannot be reached does not keep anyone in a session they asked to end.
        if (stored != null) scope.launch { factory.revoke(stored) }
        // Said again, so whoever shows each knowledge base's status reads it anew.
        synchronized(lock) { kbsHeld.raise(kbsHeld.value) }
        if (activeKbIdHeld.value == kbId) takeSession()?.close()
    }

    /** `signOut`, for Java. */
    public fun signOutFuture(kbId: String): CompletableFuture<Unit> = scope.futureOf { signOut(kbId) }

    // What is open.

    /** Open a resource in the active knowledge base. One open already takes its name, and its media type and storage URI unless each is null. Nothing is opened while it has no live session. */
    @JvmOverloads
    @JvmExposeBoxed
    public fun addOpenResource(resourceId: ResourceId, name: String, mediaType: String? = null, storageUri: String? = null): Unit = changeOpen { tabs ->
        val at = tabs.indexOfFirst { it.id == resourceId }
        if (at >= 0) {
            tabs.toMutableList().also { it[at] = it[at].copy(name = name, mediaType = mediaType ?: it[at].mediaType, storageUri = storageUri ?: it[at].storageUri) }
        } else {
            // After the last place taken, not the count: a place freed by a removal is not handed out twice.
            tabs + OpenResource(resourceId, name, System.currentTimeMillis(), tabs.maxOfOrNull { it.order + 1 } ?: 0, mediaType, storageUri)
        }
    }

    /** Close a resource in the active knowledge base. */
    @JvmExposeBoxed
    public fun removeOpenResource(resourceId: ResourceId): Unit = changeOpen { tabs -> tabs.filter { it.id != resourceId } }

    /** Give an open resource of the active knowledge base a name. */
    @JvmExposeBoxed
    public fun updateOpenResourceName(resourceId: ResourceId, name: String): Unit = changeOpen { tabs -> tabs.map { if (it.id == resourceId) it.copy(name = name) else it } }

    /** Move the open resource at one place in the shown list to another. A place that is not in the list moves nothing. */
    public fun reorderOpenResources(from: Int, to: Int): Unit = changeOpen { tabs ->
        if (from !in tabs.indices || to !in tabs.indices) {
            tabs
        } else {
            sortOpenResources(tabs).toMutableList().apply { add(to, removeAt(from)) }.mapIndexed { place, tab -> tab.copy(order = place) }
        }
    }

    /** Record the resource a person is looking at, in the active knowledge base. Nothing is recorded while it has no live session. */
    @JvmExposeBoxed
    public fun setLastViewedResource(resourceId: ResourceId): Unit = synchronized(lock) {
        val kbId = liveKbId() ?: return
        changeViewed { it + (kbId to resourceId) }
    }

    /**
     * Ask the active knowledge base to describe itself again, and say what it
     * answered. Asking is not activating: an answer as the entry is recorded on
     * it, and a different knowledge base answering is reported. Nothing is
     * voided and nothing raised.
     */
    public suspend fun readActiveKb(): KbReadVerdict {
        val session = activeSessionHeld.value ?: return NO_VERDICT
        val kbId = activeKbIdHeld.value ?: return NO_VERDICT
        return readKb(session, kbId)
    }

    /** `readActiveKb`, for Java. */
    public fun readActiveKbFuture(): CompletableFuture<KbReadVerdict> = scope.futureOf { readActiveKb() }

    /** End the registry: its session is closed, and everything it holds ends. Closing twice is closing once. */
    override fun close() {
        synchronized(lock) {
            if (closing) return
            closing = true
        }
        val taken = takeSession()
        listening?.close()
        taken?.close()
        scope.cancel()
        failures.close()
        for (held in listOf(kbsHeld, activeKbIdHeld, activeSessionHeld, activeSignalsHeld, activatingHeld, openResourcesHeld, lastViewedHeld, identityTokenHeld)) held.end()
        bus.destroy()
    }

    // Within.

    private fun putKbs(kbs: List<KnowledgeBase>) {
        if (closing) return
        saveKnowledgeBases(storage, kbs)
        kbsHeld.raise(kbs)
    }

    private fun putActiveId(kbId: String?) {
        if (closing) return
        if (kbId == null) storage.delete(ACTIVE_KEY) else storage.set(ACTIVE_KEY, kbId)
        activeKbIdHeld.set(kbId)
    }

    // The active session.

    /** Take the live session out: its readers see none, and what is open is shown no more. Whoever takes it closes it. */
    private fun takeSession(): Live? = synchronized(lock) {
        val taken = live ?: return null
        live = null
        activeSessionHeld.set(null)
        activeSignalsHeld.set(null)
        project()
        taken
    }

    /** Put a session that is up as the live one: the signals first, since its arrival's checks say a conflict through them. A session is put once, so what is open is checked once per session. */
    private fun putSession(live: Live) {
        synchronized(lock) {
            this.live = live
            activeSignalsHeld.set(live.signals)
            activeSessionHeld.set(live.opened.session)
            project()
        }
        scope.launch { checkOpenResources(live.opened.session) }
    }

    private suspend fun setActive(kbId: String?) {
        if (closing) return
        val previous = activeKbIdHeld.value
        if (kbId == previous && activeSessionHeld.value != null) return
        // Said at once: what is meant now is `kbId`, and no session is live. An activation that waited reads this to learn it was overtaken.
        if (previous != kbId) synchronized(lock) { putActiveId(kbId) }
        val taken = takeSession()
        activating(+1)
        try {
            turn.withLock {
                taken?.close()
                if (!closing && activeKbIdHeld.value == kbId) {
                    // One left live by whoever had the turn before.
                    takeSession()?.close()
                    if (kbId != null) activate(kbId)
                }
            }
        } finally {
            activating(-1)
        }
    }

    private fun activating(change: Int): Unit = synchronized(lock) {
        activations += change
        activatingHeld.set(activations > 0)
    }

    private suspend fun activate(kbId: String) {
        val kb = kbsHeld.value.firstOrNull { it.id == kbId } ?: return
        // The signals exist before the session does: the session says it is over through them, and may be over before it is ready.
        val signals = SessionSignals()
        val opened = try {
            // Built on the registry's own threads, whoever asked: a session works on the dispatcher it is started on.
            withContext(Dispatchers.Default) { factory.session(SessionFactoryOptions(kb, storage, signals, ::failed)) }
        } catch (refused: SemiontError) {
            if (!closing) failed(constructFailed(refused, kb.id))
            signals.close()
            return
        }
        // Heard from the moment it is held: a refusal while it starts is routed too.
        val heard = opened.session.errors()
        val live = Live(opened, signals, scope.launch { route(opened.session, heard, signals) })
        try {
            opened.session.ready()
        } catch (ended: Throwable) {
            live.close()
            throw ended
        }
        if (closing || activeKbIdHeld.value != kbId) {
            live.close()
            return
        }
        putSession(live)
    }

    private fun failed(error: SessionError) {
        failures.deliver(error)
    }

    /**
     * Route what the session's transport fails at. A refusal for want of a
     * valid token renews the session: it heals quietly, or the session ends
     * itself and says so once. A refusal for lack of permission has no remedy,
     * and is said.
     */
    private suspend fun route(session: SemiontSession, heard: Events<SemiontError>, signals: SessionSignals) = heard.use {
        it.collect { failure ->
            if (failure is TransportError) {
                when (failure.reason) {
                    // Refusals that arrive together are answered by one renewal: the session holds them while it renews.
                    TransportErrorCode.Unauthorized -> scope.launch { session.refresh() }
                    TransportErrorCode.Forbidden -> signals.notifyPermissionDenied(failure.message)
                    else -> Unit
                }
            }
        }
    }

    // What is shown.

    /** The id of the active knowledge base when it has a live session; null otherwise. */
    private fun liveKbId(): String? = if (activeSessionHeld.value == null) null else activeKbIdHeld.value

    /** Show what is open, and where the person was, in the active knowledge base: only while it has a live session. Called under the lock. */
    private fun project() {
        val kbId = liveKbId()
        if (kbId == null) {
            openResourcesHeld.set(emptyList())
            lastViewedHeld.set(null)
            return
        }
        openResourcesHeld.set(sortOpenResources(openByKb[kbId].orEmpty()))
        lastViewedHeld.set(viewedByKb[kbId])
    }

    /** Change what is open in the active knowledge base, against what the storage holds, as one step. */
    private fun changeOpen(change: (List<OpenResource>) -> List<OpenResource>): Unit = synchronized(lock) {
        val kbId = liveKbId() ?: return
        changeOpenOf(kbId, change)
        project()
    }

    private fun changeOpenOf(kbId: String, change: (List<OpenResource>) -> List<OpenResource>) {
        var committed = openByKb
        storage.update(OPEN_RESOURCES_BY_KB_KEY) { stored ->
            val byKb = storedAs(OPEN_BY_KB, stored).toMutableMap()
            byKb[kbId] = change(byKb[kbId].orEmpty())
            committed = byKb
            wireJson.encodeToString(OPEN_BY_KB, byKb)
        }
        openByKb = committed
    }

    /** Change where the person was in each knowledge base, against what the storage holds, as one step. Called under the lock. */
    private fun changeViewed(change: (Map<String, ResourceId>) -> Map<String, ResourceId>) {
        var committed = viewedByKb
        storage.update(LAST_VIEWED_RESOURCE_BY_KB_KEY) { stored ->
            change(storedAs(VIEWED_BY_KB, stored)).also { committed = it }.let { wireJson.encodeToString(VIEWED_BY_KB, it) }
        }
        viewedByKb = committed
        project()
    }

    /** Forget what was open in a knowledge base, and where the person was. */
    private fun forgetKeptOf(kbId: String): Unit = synchronized(lock) {
        var committed = openByKb
        storage.update(OPEN_RESOURCES_BY_KB_KEY) { stored ->
            (storedAs(OPEN_BY_KB, stored) - kbId).also { committed = it }.let { wireJson.encodeToString(OPEN_BY_KB, it) }
        }
        openByKb = committed
        changeViewed { it - kbId }
    }

    /**
     * Another context changed what is open, or where the person was. Read on
     * the registry's own threads, not the writer's, and from what the storage
     * holds then, so a change made here meanwhile is not put back.
     */
    private fun writtenElsewhere(key: String, value: String?) {
        if (closing || value == null || (key != OPEN_RESOURCES_BY_KB_KEY && key != LAST_VIEWED_RESOURCE_BY_KB_KEY)) return
        scope.launch {
            synchronized(lock) {
                if (closing) return@launch
                openByKb = storedAs(OPEN_BY_KB, storage.get(OPEN_RESOURCES_BY_KB_KEY))
                viewedByKb = storedAs(VIEWED_BY_KB, storage.get(LAST_VIEWED_RESOURCE_BY_KB_KEY))
                project()
            }
        }
    }

    // The checks a session's arrival starts.

    private fun isLive(session: SemiontSession): Boolean = !closing && activeSessionHeld.value?.id == session.id

    private suspend fun checkOpenResources(session: SemiontSession) {
        // The session's own knowledge base: by the time this runs, another may be the active one.
        val kbId = session.kb.id
        // Who it is, first: if a different knowledge base is answering, every answer about a resource would be an answer to a question asked of the wrong one.
        val verdict = readKb(session, kbId)
        if (verdict.kind == KbReadKind.Conflict) {
            // The read was of this session's knowledge base: what it voids is the active one's, so only while this is still the active one.
            val observed = verdict.observedDid
            if (isLive(session) && observed != null) voidForConflict(kbId, observed)
            return
        }
        // What the storage holds, not what is in memory: another context may have opened a resource before this session came up.
        val waiting = storedAs(OPEN_BY_KB, storage.get(OPEN_RESOURCES_BY_KB_KEY))[kbId].orEmpty().map { it.id }
        if (waiting.isEmpty()) return
        val lanes = Semaphore(CHECKS_AT_ONCE)
        val checks = coroutineScope { waiting.map { id -> async { lanes.withPermit { id to checked(session, id) } } }.awaitAll() }.toMap()
        synchronized(lock) {
            if (isLive(session) && liveKbId() == kbId) {
                changeOpenOf(kbId) { applyTabChecks(it, checks) }
                project()
            }
        }
    }

    /**
     * Ask the knowledge base to describe itself, against the entry it is asked
     * as. If it is the one the entry says, its name and branch are recorded on
     * the entry; otherwise nothing is recorded. A did that differs says a
     * different knowledge base answered; one that matches says nothing about
     * what is in it, which is each resource's own check.
     */
    private suspend fun readKb(session: SemiontSession, kbId: String): KbReadVerdict {
        val entry = kbsHeld.value.firstOrNull { it.id == kbId } ?: return NO_VERDICT
        val description = try {
            session.client.browse.kb()
        } catch (_: SemiontError) {
            return NO_VERDICT
        }
        val observed = try {
            kbDid(description.domain).value
        } catch (_: IllegalArgumentException) {
            // A domain no did can hold: a knowledge base that could not say who it is.
            return NO_VERDICT
        }
        if (observed != entry.did) return KbReadVerdict(KbReadKind.Conflict, observed, description.name)
        if (closing) return NO_VERDICT
        updateKb(kbId, description.name, readNow(description))
        return KbReadVerdict(KbReadKind.Recorded)
    }

    /** A different knowledge base answered for the active entry: what claims to be about its contents is voided, both at once, and the conflict is raised. Registering the one that answered is a person's act. */
    private fun voidForConflict(kbId: String, observedDid: String) {
        val signals = synchronized(lock) {
            val entry = kbsHeld.value.firstOrNull { it.id == kbId } ?: return
            changeOpenOf(kbId) { emptyList() }
            changeViewed { it - kbId }
            activeSignalsHeld.value?.let { it to entry.did }
        } ?: return
        signals.first.notifyKbIdentityConflict(KbIdentityConflict(signals.second, observedDid))
    }
}
