package semiont.registry

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertFalse
import semiont.ClientTiming
import semiont.cache.CacheQuery
import semiont.cache.CacheState
import semiont.cache.PERSISTED_QUERIES
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.http.Realm
import semiont.http.Said
import semiont.http.ownHttp
import semiont.http.sessionStarted
import semiont.http.tokenFor
import semiont.identifiers.ResourceId
import semiont.session.OpenedSession
import semiont.session.SemiontSession
import semiont.signin.HeldSignIn
import semiont.signin.MemorySignIn
import semiont.signin.SignInKept
import semiont.storage.SessionStorage
import semiont.testing.FaultyTransport
import semiont.testing.ScriptedSessions
import semiont.testing.SharedStorage
import semiont.transport.ConnectionState
import semiont.transport.Watched
import semiont.types.HttpEndpoint
import semiont.types.HttpEndpointProtocol
import semiont.types.KbRead
import semiont.types.KbTarget
import semiont.types.KnowledgeBase
import semiont.types.UserResponse
import semiont.types.wireJson
import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.random.Random
import kotlin.time.TimeSource

internal const val KB_A = "kb-a"
internal const val KB_B = "kb-b"
internal const val DID_A = "did:web:example.org:kb-a"
internal const val DID_B = "did:web:example.org:kb-b"
internal const val KB_REQUESTED = "browse:kb-requested"
internal const val RESOURCE_REQUESTED = "browse:resource-requested"

/** Whether a transport a factory built has been closed. */
internal val FaultyTransport.closed: Boolean get() = state.value == ConnectionState.Closed

/** Who Alice is, as a gateway says. */
private const val ALICE_AS_SAID = """{"did":"did:web:example.org:users:alice","email":"alice@example.org","name":"Alice","image":null,"domain":"example.org","isAdmin":false,"isModerator":false,"termsAcceptedAt":null}"""

internal fun alice(): UserResponse = wireJson.decodeFromString(UserResponse.serializer(), ALICE_AS_SAID)

/** The key what is kept for Alice is kept under. */
internal val ALICE_KEY: String = personKey(alice().did.value)

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
        it.refuseWhen(behind::refuse)
        it.saysWho(alice())
    }

    fun says(kbId: String, said: JsonObject) {
        behind.describes[kbId] = said
    }

    /** The resources a knowledge base's sessions were asked about, in order. */
    fun askedAbout(kbId: String): List<String> =
        sessions.transports(kbId).flatMap { transport -> transport.emitted.filter { it.channel == RESOURCE_REQUESTED }.map { resourceOf(it.payload) } }

    /** How often a knowledge base's sessions asked it who it is. */
    fun askedWho(kbId: String): Int = sessions.transports(kbId).sumOf { transport -> transport.emitted.count { it.channel == KB_REQUESTED } }
}

/** A factory that builds no session until `letGo`: a registry building one waits, and `sessions` builds it then. */
internal class HeldSessions(private val sessions: ScriptedSessions) : SessionFactory {
    private val released = CompletableDeferred<Unit>()

    /** Complete once a registry has asked for a session. */
    val asked = CompletableDeferred<Unit>()

    fun letGo() {
        released.complete(Unit)
    }

    override suspend fun session(options: SessionFactoryOptions): OpenedSession {
        asked.complete(Unit)
        released.await()
        return sessions.session(options)
    }

    override suspend fun revoke(stored: StoredSession): Unit = sessions.revoke(stored)
}

/** A step a storage takes when it is asked to write the save kb-a's client owes. */
internal const val WROTE_THE_OWED_SAVE = "wrote the owed save"

/** Where kb-a's client writes the save it owes: what it keeps of a resource for Alice. */
private val OWED_SAVE = cacheKey(KB_A, ALICE_KEY, CacheQuery.Resource.wire)

/** Whether `key` is one kb-a's client writes what it keeps for Alice under: its kept queries' documents, and its stream's places. */
private fun ofKbAsClient(key: String): Boolean =
    key == lastEventIdKey(KB_A, ALICE_KEY) || PERSISTED_QUERIES.any { key == cacheKey(KB_A, ALICE_KEY, it.query.wire) }

/**
 * What the sessions of `KeepingSessions` keep, in `beneath`. Each ask to
 * write the save kb-a's client owes puts `WROTE_THE_OWED_SAVE` in `steps`,
 * and the first runs `within`, once one is given, holding the write open while
 * it runs. While `refuses` holds, it refuses every write of kb-a's client,
 * keeping nothing of it.
 */
internal class SteppedCaches(private val steps: MutableList<String>, private val beneath: SessionStorage) : SessionStorage by beneath {
    @Volatile
    var refuses = false

    @Volatile
    var within: (() -> Unit)? = null

    private val entered = AtomicBoolean(false)

    private fun asked(key: String, writes: Boolean) {
        if (writes && key == OWED_SAVE) {
            steps += WROTE_THE_OWED_SAVE
            within?.let { if (entered.compareAndSet(false, true)) it() }
        }
        if (refuses && ofKbAsClient(key)) throw IOException("the storage refuses every write of kb-a's client")
    }

    override fun set(key: String, value: String) {
        asked(key, writes = true)
        beneath.set(key, value)
    }

    override fun delete(key: String) {
        asked(key, writes = false)
        beneath.delete(key)
    }

    override fun update(key: String, change: (String?) -> String?) {
        asked(key, writes = true)
        beneath.update(key, change)
    }
}

/**
 * A factory of sessions over HTTP, at the gateway each knowledge base names,
 * over the sign-in `kept`, as a registry's are built: each client keeps what it
 * holds for the person `kept` names, in `caches`, and its caches wait an hour,
 * longer than any test, after what they hold last changed before they save, so
 * its closing is the first to make a save one owes. It reads none of its
 * sessions' errors, and revokes nothing.
 */
internal class KeepingSessions(private val kept: SignInKept, private val caches: SessionStorage) : SessionFactory {
    override suspend fun session(options: SessionFactoryOptions): OpenedSession = sessionStarted(
        KbTarget(options.kb.id, options.kb.label, options.kb.endpoint),
        kept,
        true,
        caches,
        options.signals::notifySessionEnded,
        ownHttp,
        Dispatchers.Default,
        TimeSource.Monotonic,
        Random.Default,
        ClientTiming(saveDebounceMs = TimeUnit.HOURS.toMillis(1)),
    )

    override suspend fun revoke(stored: StoredSession): Unit = Unit
}

/**
 * A storage in which kb-a and kb-b are registered at `realm`'s gateway, kb-a
 * active. The gateway names Alice to each of their sessions as it asks who its
 * token is, and its knowledge base answers each read of a resource.
 */
internal fun registeredAt(realm: Realm): SharedStorage {
    realm.answersFresh()
    val namesAlice = Said(200, Json.parseToJsonElement(ALICE_AS_SAID).jsonObject)
    realm.script("/api/users/me", namesAlice, namesAlice)
    val at = endpoint("127.0.0.1", URI(realm.origin).port.toLong())
    val storage = SharedStorage()
    saveKnowledgeBases(storage, listOf(kb(KB_A, "KB A", DID_A, at), kb(KB_B, "KB B", DID_B, at)))
    storage.set(ACTIVE_KEY, KB_A)
    return storage
}

/** A sign-in that names Alice, renewed at `realm`'s issuer. */
internal fun keptNamingAlice(realm: Realm): SignInKept =
    MemorySignIn(HeldSignIn(tokenFor("access"), "r1", "semiont-browser", "${realm.origin}/token", "${realm.origin}/revoke", ALICE_KEY))

/** Leave the client of `session`, one of `KeepingSessions`', owing its save: a fresh read of a resource, which its closing is the first to write. */
internal suspend fun owingItsSave(session: SemiontSession) {
    soon { session.client.browse.resource(ResourceId("res-1")).first { it is CacheState.Ready } }
    assertFalse(session.client.persistenceSettled, "the client owes no save")
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
