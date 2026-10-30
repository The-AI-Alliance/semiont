package semiont.registry

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import semiont.Recording
import semiont.SemiontClient
import semiont.bus.OPERATIONS
import semiont.errors.SemiontError
import semiont.errors.SessionError
import semiont.errors.SessionErrorCode
import semiont.errors.SignInError
import semiont.errors.SignInErrorCode
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.http.tokenFor
import semiont.identifiers.ResourceId
import semiont.session.OpenedSession
import semiont.session.SemiontSession
import semiont.storage.SessionStorage
import semiont.storage.SharedStorage
import semiont.transport.Broadcast
import semiont.transport.ConnectionState
import semiont.transport.Events
import semiont.transport.Frame
import semiont.transport.FrameSink
import semiont.transport.PendingReply
import semiont.transport.ReplyRouter
import semiont.transport.ResourceHold
import semiont.transport.Transport
import semiont.transport.Watched
import semiont.types.HttpEndpoint
import semiont.types.HttpEndpointProtocol
import semiont.types.KbRead
import semiont.types.KbTarget
import semiont.types.KnowledgeBase
import semiont.types.UserResponse
import semiont.types.wireJson
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

internal const val KB_A = "kb-a"
internal const val KB_B = "kb-b"
internal const val DID_A = "did:web:example.org:kb-a"
internal const val DID_B = "did:web:example.org:kb-b"
internal const val KB_REQUESTED = "browse:kb-requested"
internal const val RESOURCE_REQUESTED = "browse:resource-requested"

/** What answers a knowledge base's request: given its id, the operation and the payload, the response, or null for a reply that carries none, or a refusal thrown. */
internal typealias Answer = (kbId: String, operation: String, payload: JsonObject) -> JsonElement?

/** What refuses a knowledge base's request on its operation's failure channel: the failure's payload, or null to answer as usual. */
internal typealias Refusal = (kbId: String, operation: String, payload: JsonObject) -> JsonObject?

/**
 * One knowledge base's gateway as a scripted session's client meets it: each
 * request answered by `answer` or refused by `refuse`, each kept, and a
 * failure of the transport delivered when a test says (`fail`).
 */
internal class Scripted(private val kbId: String, private val answer: Answer, private val refuse: () -> Refusal?) : Transport {
    val requests = CopyOnWriteArrayList<Frame>()
    private val router = ReplyRouter()
    private val now = MutableStateFlow(ConnectionState.Open)
    private val failing = Broadcast<SemiontError>()

    val closed: Boolean get() = now.value == ConnectionState.Closed

    /** Fail as a transport does: what the session's readers of its failures hear. */
    fun fail(error: SemiontError) {
        failing.deliver(error)
    }

    override val baseUrl: String = "http://$kbId.test"
    override val state: Watched<ConnectionState> = Watched(now) { it == ConnectionState.Closed }

    override suspend fun emit(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): Long? {
        requests += Frame(channel, payload, correlationId, scope)
        if (correlationId == null) return 1
        val operation = OPERATIONS.getValue(channel)
        refuse()?.invoke(kbId, channel, payload)?.let { failure ->
            router.route(Frame(operation.failure.name, failure, correlationId))
            return 1
        }
        val response = answer(kbId, channel, payload) ?: JsonNull
        val named = operation.replyNames.associateWith { payload.getValue(it) }
        router.route(Frame(operation.result.name, JsonObject(named + ("response" to response)), correlationId))
        return 1
    }

    override fun emitFuture(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): CompletableFuture<Long?> =
        throw UnsupportedOperationException("the client emits by its own future")

    override fun frames(channel: String): Events<Frame> = Broadcast<Frame>().listen()

    override fun isSubscribed(channel: String): Boolean = true

    override fun subscribeToResource(resourceId: ResourceId): ResourceHold = ResourceHold {}

    override fun failures(): Events<SemiontError> = failing.listen()

    override fun bridgeInto(bus: FrameSink) = Unit

    override fun trackReply(correlationId: String, replyChannels: Collection<String>): PendingReply = router.track(correlationId, replyChannels)

    override fun close() {
        now.value = ConnectionState.Closed
        router.close()
    }
}

private fun refuseUnscripted(kbId: String, operation: String, payload: JsonObject): JsonElement? =
    throw TransportError(TransportErrorCode.Error, "No response scripted for '$operation' of knowledge base '$kbId'. Build the factory with an answer.")

/**
 * A `SessionFactory` for tests of a registry: each session it builds is a
 * real `SemiontSession` over a `Scripted` transport of its own, and it keeps
 * every transport it built, by knowledge base. A test scripts what each
 * gateway answers, who it says a token is, and what a renewal gives; each
 * refuses by name until it is scripted.
 */
internal class ScriptedSessions(private val answer: Answer = ::refuseUnscripted) : SessionFactory {
    @Volatile
    var refuse: Refusal? = null

    /** Refuse to build any session, saying why; null builds again. */
    @Volatile
    var refusesToBuild: String? = null

    /** Who the gateway says a token is, of every session built from now. */
    @Volatile
    var user: UserResponse? = null

    /** How long the gateway takes to say who a token is, of every session built from now. */
    @Volatile
    var answersAfterMs: Long = 0

    private val renewals = ArrayDeque<String?>()
    val renewed = AtomicInteger()
    private val built = CopyOnWriteArrayList<Pair<String, Scripted>>()
    val revoked = CopyOnWriteArrayList<StoredSession>()

    /** What the next renewals give, one each, in order: a token, or null for a session that has nothing to renew with. */
    fun queueRenewals(vararg given: String?): Unit = synchronized(renewals) { renewals.addAll(given) }

    /** The transports of the sessions built for a knowledge base, in the order they were built. */
    fun transports(kbId: String): List<Scripted> = built.filter { it.first == kbId }.map { it.second }

    override suspend fun session(options: SessionFactoryOptions): OpenedSession {
        val kbId = options.kb.id
        refusesToBuild?.let { throw SessionError(SessionErrorCode.ConstructFailed, it, kbId) }
        val transport = Scripted(kbId, answer) { refuse }
        built += kbId to transport
        val unused = Recording()
        val client = SemiontClient(transport, unused, unused)
        val user = user
        val wait = answersAfterMs
        val session = SemiontSession(
            KbTarget(kbId, options.kb.label, options.kb.endpoint),
            client,
            MutableStateFlow(null),
            keptIn(options.storage, kbId),
            {
                renewed.incrementAndGet()
                val renewal = synchronized(renewals) {
                    if (renewals.isEmpty()) throw SignInError(SignInErrorCode.Exchange, "ScriptedSessions: not scripted: a renewal of '$kbId'. Script one with queueRenewals.")
                    renewals.removeFirst()
                }
                renewal
            },
            { _: String ->
                delay(wait)
                user ?: throw TransportError(TransportErrorCode.Error, "ScriptedSessions: not scripted: who a token of '$kbId' is.")
            },
            options.signals::notifySessionEnded,
            options.onError,
        )
        session.start()
        return OpenedSession(session) { transport.close() }
    }

    override suspend fun revoke(stored: StoredSession) {
        revoked += stored
    }
}

internal fun alice(): UserResponse = wireJson.decodeFromString(
    UserResponse.serializer(),
    """{"did":"did:web:example.org:users:alice","email":"alice@example.org","name":"Alice","image":null,"domain":"example.org","isAdmin":false,"isModerator":false,"termsAcceptedAt":null}""",
)

private fun resourceOf(payload: JsonObject): String = payload.getValue("resourceId").jsonPrimitive.content

/** What the knowledge bases behind the factory say of themselves and of each resource. */
internal class Behind {
    /** What each knowledge base says when asked who it is, by its id. One with none does not answer at all. */
    val describes = java.util.concurrent.ConcurrentHashMap<String, JsonObject>()

    /** The knowledge bases that answer that they cannot say what they are. */
    val refusing: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()

    /** The resources the knowledge base says do not exist. */
    val gone: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()

    /** The resources whose read fails some other way. */
    val failing: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()
    val mediaTypes = java.util.concurrent.ConcurrentHashMap<String, String>()

    fun answer(kbId: String, operation: String, payload: JsonObject): JsonElement? = when (operation) {
        KB_REQUESTED -> {
            val said = describes[kbId]
            if (said == null || kbId in refusing) throw TransportError(TransportErrorCode.Error, "the knowledge base does not answer")
            said
        }
        RESOURCE_REQUESTED -> {
            val resource = resourceOf(payload)
            if (resource in failing) throw TransportError(TransportErrorCode.Error, "$resource could not be read")
            val representations = mediaTypes[resource]?.let { JsonArray(listOf(buildJsonObject { put("mediaType", it) })) } ?: JsonArray(emptyList())
            buildJsonObject {
                put("resource", buildJsonObject {
                    put("@context", "https://schema.org")
                    put("@id", resource)
                    put("name", "name-$resource")
                    put("representations", representations)
                })
                put("lastSequence", 1)
            }
        }
        else -> throw TransportError(TransportErrorCode.Error, "$operation is not answered here")
    }

    fun refuse(kbId: String, operation: String, payload: JsonObject): JsonObject? = when {
        operation == KB_REQUESTED && kbId in refusing -> buildJsonObject { put("message", "this knowledge base cannot say what it is") }
        operation == RESOURCE_REQUESTED && resourceOf(payload) in gone -> buildJsonObject {
            put("code", "not-found")
            put("message", "no such resource")
        }
        else -> null
    }
}

/** Scripted sessions, and what their knowledge bases say of themselves and of each resource. */
internal class Factory {
    val behind = Behind()
    val sessions = ScriptedSessions(behind::answer).also {
        it.refuse = behind::refuse
        it.user = alice()
    }

    fun says(kbId: String, said: JsonObject) {
        behind.describes[kbId] = said
    }

    /** The resources a knowledge base's sessions were asked about, in order. */
    fun askedAbout(kbId: String): List<String> =
        sessions.transports(kbId).flatMap { transport -> transport.requests.filter { it.channel == RESOURCE_REQUESTED }.map { resourceOf(it.payload) } }

    /** How often a knowledge base's sessions asked it who it is. */
    fun askedWho(kbId: String): Int = sessions.transports(kbId).sumOf { transport -> transport.requests.count { it.channel == KB_REQUESTED } }
}

internal fun endpoint(host: String, port: Long): HttpEndpoint =
    HttpEndpoint(host = host, port = port, protocol = if (host == "localhost" || host == "127.0.0.1") HttpEndpointProtocol.Http else HttpEndpointProtocol.Https)

internal fun kb(kbId: String, label: String, did: String, at: HttpEndpoint, lastRead: KbRead? = null): KnowledgeBase = KnowledgeBase(kbId, label, at, did, lastRead)

internal fun kbOfA(): KnowledgeBase = kb(KB_A, "KB A", DID_A, endpoint("localhost", 4000))

internal fun kbOfB(): KnowledgeBase = kb(KB_B, "KB B", DID_B, endpoint("example.com", 443))

internal fun tokens(refresh: String, access: String = tokenFor("access")): StoredSession =
    StoredSession(access, refresh, "semiont-browser", "https://issuer.test/token", "https://issuer.test/revoke")

internal fun description(name: String, domain: String, branch: String? = null): JsonObject = buildJsonObject {
    put("name", name)
    put("domain", domain)
    branch?.let { put("gitBranch", it) }
}

/** A storage and a factory, and the registries over them. */
internal class World {
    val storage = SharedStorage()
    val factory = Factory()

    /** A storage that already holds these knowledge bases, signed in, with the first of them active. */
    fun with(vararg kbs: KnowledgeBase): World {
        saveKnowledgeBases(storage, kbs.toList())
        kbs.forEach { storeSession(storage, it.id, tokens("r")) }
        kbs.firstOrNull()?.let { storage.set(ACTIVE_KEY, it.id) }
        return this
    }

    /** A registry over `over`, or this world's storage. */
    fun browser(over: SessionStorage = storage): SemiontBrowser = SemiontBrowser(SemiontBrowserConfig(over, factory.sessions))

    fun stored(key: String): JsonElement? = storage.get(key)?.let { Json.parseToJsonElement(it) }

    fun storedOpen(kbId: String): List<String> =
        ((stored(OPEN_RESOURCES_BY_KB_KEY) as? JsonObject)?.get(kbId) as? JsonArray).orEmpty().map { it.jsonObject.getValue("id").jsonPrimitive.content }

    fun storedLastViewed(): Map<String, String> =
        (stored(LAST_VIEWED_RESOURCE_BY_KB_KEY) as? JsonObject).orEmpty().mapValues { it.value.jsonPrimitive.content }

    fun storedRefresh(kbId: String): String? = storedSession(storage, kbId)?.refresh

    /** Store `ids` as open in a knowledge base, each under a stale name. */
    fun opened(kbId: String, vararg ids: String) {
        val byKb = (stored(OPEN_RESOURCES_BY_KB_KEY) as? JsonObject).orEmpty()
        val tabs = ids.mapIndexed { place, id ->
            buildJsonObject {
                put("id", id)
                put("name", "stale-$id")
                put("openedAt", place)
                put("order", place)
            }
        }
        storage.set(OPEN_RESOURCES_BY_KB_KEY, JsonObject(byKb + (kbId to JsonArray(tabs))).toString())
    }
}

/** Until `done`, ten seconds at most. */
internal suspend fun eventually(what: String, done: () -> Boolean) {
    withTimeoutOrNull(10_000) {
        while (!done()) delay(5)
    } ?: throw AssertionError("$what did not happen")
}

/** Let what the registry started run: what a check that nothing more happens waits. */
internal suspend fun settle(): Unit = delay(200)

/** The registry's live session, once it has one, with what its arrival starts let run. */
internal suspend fun live(browser: SemiontBrowser): SemiontSession {
    eventually("a session came up") { browser.activeSession.value != null }
    settle()
    return checkNotNull(browser.activeSession.value)
}

/** Whether a reader of something a registry showed sees no more: its changes end once it is given the value now. */
internal suspend fun <T> ended(watched: Watched<T>): Boolean {
    var seen = 0
    return withTimeoutOrNull(1_000) {
        watched.collect { seen += 1 }
        seen == 1
    } ?: false
}

internal fun shown(browser: SemiontBrowser): List<String> = browser.openResources.value.map { it.id.value }

internal fun sessionOf(browser: SemiontBrowser): String? = browser.activeSession.value?.kb?.id

/** Wait, at most `ms`, for nothing in particular: a test that something takes long holds this long at most. */
internal suspend fun <T> soon(ms: Long = 10_000, work: suspend () -> T): T = withTimeout(ms) { work() }
