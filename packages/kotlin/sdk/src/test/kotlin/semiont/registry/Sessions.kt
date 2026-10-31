package semiont.registry

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
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
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.http.tokenFor
import semiont.session.OpenedSession
import semiont.session.SemiontSession
import semiont.storage.SessionStorage
import semiont.testing.FaultyTransport
import semiont.testing.ScriptedSessions
import semiont.testing.SharedStorage
import semiont.transport.ConnectionState
import semiont.transport.Watched
import semiont.types.HttpEndpoint
import semiont.types.HttpEndpointProtocol
import semiont.types.KbRead
import semiont.types.KnowledgeBase
import semiont.types.UserResponse
import semiont.types.wireJson

internal const val KB_A = "kb-a"
internal const val KB_B = "kb-b"
internal const val DID_A = "did:web:example.org:kb-a"
internal const val DID_B = "did:web:example.org:kb-b"
internal const val KB_REQUESTED = "browse:kb-requested"
internal const val RESOURCE_REQUESTED = "browse:resource-requested"

/** Whether a transport a factory built has been closed. */
internal val FaultyTransport.closed: Boolean get() = state.value == ConnectionState.Closed

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
