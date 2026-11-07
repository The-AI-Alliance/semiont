package semiont.registry

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.SemiontClient
import semiont.Spec
import semiont.cache.CacheState
import semiont.cache.PERSISTED_QUERIES
import semiont.http.HttpSessionFactory
import semiont.http.Realm
import semiont.http.Said
import semiont.http.issued
import semiont.http.sessionFromKept
import semiont.http.tokenFor
import semiont.identifiers.ResourceId
import semiont.session.OpenedSession
import semiont.session.SessionSignals
import semiont.signin.HeldSignIn
import semiont.signin.MemorySignIn
import semiont.signin.SCRIPT_CLIENT_ID
import semiont.storage.MemoryStorage
import semiont.storage.SessionStorage
import semiont.testing.ScriptedSessions
import semiont.testing.SharedStorage
import semiont.types.HttpEndpoint
import semiont.types.HttpEndpointProtocol
import semiont.types.KbTarget
import semiont.types.KnowledgeBase
import semiont.types.ResourceDescriptor
import semiont.types.UserResponse
import semiont.types.wireJson
import java.net.URI
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private val cases = Spec.read("session/persisted-cases.json").jsonObject

private fun JsonObject.text(name: String): String = getValue(name).jsonPrimitive.content

private fun JsonObject.textOrNull(name: String): String? = get(name)?.takeUnless { it is JsonNull }?.jsonPrimitive?.content

private fun rows(part: String): List<JsonObject> = cases.getValue(part).jsonArray.map { it.jsonObject }

private fun storedOf(part: String): Map<String, String> = cases.getValue(part).jsonObject.mapValues { it.value.jsonPrimitive.content }

/** The members of each part's rows the runner reads. */
private val MEMBERS = mapOf(
    "keys" to setOf("why", "kbId", "did", "personKey", "lastEventIdKey", "cacheKeys"),
    "forget" to setOf("why", "by", "stored", "signedIn", "open", "removes"),
    "startup" to setOf("why", "signedIn", "gateway", "first", "then", "recorded", "place", "untouched"),
    "crossTab" to setOf("why", "stored", "saved"),
    "holder" to setOf("why", "stored", "saved"),
)

private val people = cases.getValue("people").jsonObject.mapValues { it.value.jsonObject }
private val JO = people.getValue("jo").text("personKey")

/** The row of `keys` that states jo's keys on kb-a. */
private val joOnARow: JsonObject = rows("keys").single { it.text("kbId") == KB_A && it.text("personKey") == JO }

/** Every key of jo's on kb-a: the stream's places and each persisted query's. */
private val JO_ON_A: Set<String> = setOf(joOnARow.text("lastEventIdKey")) + joOnARow.getValue("cacheKeys").jsonObject.values.map { it.jsonPrimitive.content }
private val JO_RESOURCE_ON_A: String = joOnARow.getValue("cacheKeys").jsonObject.text("resource")

/** What storage holds before each row of `forget`. */
private val FORGET_STORAGE: Map<String, String> = storedOf("forgetStorage")

private val whoAmI: JsonObject = cases.getValue("whoAmI").jsonObject

private val prefixes: List<String> = Spec.read("session/stored.json").jsonObject.let { stored ->
    listOf("lastEventIdKeyPrefix", "cacheKeyPrefix").map { stored.getValue(it).jsonObject.text("prefix") }
}

private const val WHO = "/api/users/me"

/** What a gateway that cannot be reached answers: a refusal to answer, which a request is not refused again for. */
private val UNAVAILABLE = Said(503, buildJsonObject { put("error", "the gateway is unavailable") })

/** What the client of jo's, standing in for one closing with a save owed, writes as it closes. */
private const val WRITTEN_CLOSING = """{"version":1,"writtenAt":1700000000001,"entries":[]}"""

/** The gateway's refusal of a token. */
private val REFUSED = Said(401, buildJsonObject { put("error", "invalid_token") })

/** The issuer's refusal to renew a token. */
private val NOT_RENEWED = Said(400, buildJsonObject { put("error", "invalid_grant") })

/** A row the runner reads every member of: a member the table gains fails here until the runner reads it. */
private fun read(row: JsonObject, part: String) {
    val unread = row.keys - MEMBERS.getValue(part)
    assertTrue(unread.isEmpty(), "$part has members the runner does not read: $unread")
}

/** kb-a, at the realm's gateway. */
private fun Realm.kbA(): KnowledgeBase =
    KnowledgeBase(KB_A, "KB A", HttpEndpoint(host = "127.0.0.1", port = URI(origin).port.toLong(), protocol = HttpEndpointProtocol.Http), "did:web:kb.example.org")

/** A sign-in kept for the browser client, renewed and revoked at the realm's issuer, naming `personKey`, or nobody for null. */
private fun Realm.signIn(personKey: String?, access: String = tokenFor("access"), refresh: String = "r1"): StoredSession =
    StoredSession(access, refresh, "semiont-browser", "$origin/token", "$origin/revoke", personKey)

/** kb-a as a script's session reaches it, at the realm's gateway. */
private fun Realm.targetA(): KbTarget = kbA().let { KbTarget(it.id, it.label, it.endpoint) }

/** A script's sign-in, renewed at the realm's issuer, naming `personKey`, or nobody for null. */
private fun Realm.held(personKey: String?, access: String = tokenFor("access"), refresh: String = "r1"): HeldSignIn =
    HeldSignIn(access, refresh, SCRIPT_CLIENT_ID, "$origin/token", null, personKey)

/** kb-a's stored sign-in as the row's `signedIn` says, made by `signIn` for the person it names (null for nobody); null when nothing is stored. */
private fun signInOf(row: JsonObject, signIn: (String?) -> StoredSession): StoredSession? = when (val signedIn = row.text("signedIn")) {
    "named" -> signIn(JO)
    "unnamed" -> signIn(null)
    "none" -> null
    else -> throw AssertionError("signedIn $signedIn is none the runner knows")
}

/** The knowledge base behind the realm's gateway: a read of any resource is answered with that resource named `fresh`, and it cannot say what it is. */
internal fun Realm.answersFresh() {
    onEmit = { emit ->
        val correlation = emit["correlationId"]?.jsonPrimitive?.content
        val payload = emit["payload"]?.jsonObject
        if (correlation != null && payload != null) {
            when (emit["channel"]?.jsonPrimitive?.content) {
                "browse:resource-requested" -> {
                    val resource = payload.getValue("resourceId").jsonPrimitive.content
                    reply(
                        correlation,
                        "browse:resource-result",
                        buildJsonObject {
                            put("resourceId", resource)
                            put("response", buildJsonObject {
                                put("resource", buildJsonObject {
                                    put("@context", "https://schema.org/")
                                    put("@id", resource)
                                    put("name", "fresh")
                                    put("representations", JsonArray(emptyList()))
                                })
                                put("lastSequence", 1)
                            })
                        },
                    )
                }
                "browse:kb-requested" -> reply(correlation, "browse:kb-failed", buildJsonObject { put("message", "this knowledge base cannot say what it is") })
            }
        }
    }
}

private fun Realm.reply(correlation: String, channel: String, payload: JsonObject) = send(buildJsonObject {
    put("channel", channel)
    put("payload", payload)
    put("correlationId", correlation)
})

/** What the first stream to name `scope` said of it; null while none has. */
private fun Realm.scoped(scope: String): JsonObject? =
    subscriptions.flatMap { (it["scoped"] as? JsonArray).orEmpty() }.map { it.jsonObject }.firstOrNull { it["scope"]?.jsonPrimitive?.content == scope }

/** A storage in memory that says which keys it holds. No other context writes it. */
private class ListedStorage : SessionStorage {
    private val stored = ConcurrentHashMap<String, String>()

    fun keys(): Set<String> = stored.keys.toSet()

    override fun get(key: String): String? = stored[key]

    override fun set(key: String, value: String) {
        stored[key] = value
    }

    override fun delete(key: String) {
        stored.remove(key)
    }

    override fun update(key: String, change: (String?) -> String?) {
        stored.compute(key) { _, before -> change(before) }
    }

    override fun subscribe(onChange: (key: String, value: String?) -> Unit): AutoCloseable? = null
}

/**
 * A storage in memory whose first write under `held` waits, once it has begun,
 * until the test lets it go: whatever decided on the write, and whatever it was
 * checked against, came before. Every other write, and every delete, is made
 * at once. No other context writes it.
 */
private class HeldWrite(private val held: String) : SessionStorage {
    private val stored = ConcurrentHashMap<String, String>()
    private val waiting = AtomicBoolean(true)
    private val letGo = CountDownLatch(1)

    /** Complete once the write under `held` has begun, and waits. */
    val entered = CompletableDeferred<Unit>()

    /** Complete once that write has landed. */
    val landed = CompletableDeferred<Unit>()

    /** Let the write that waits land. */
    fun release(): Unit = letGo.countDown()

    private fun write(key: String, writing: () -> Unit) {
        if (key != held || !waiting.compareAndSet(true, false)) return writing()
        entered.complete(Unit)
        check(letGo.await(10, TimeUnit.SECONDS)) { "the write under $key was never let go" }
        writing()
        landed.complete(Unit)
    }

    override fun get(key: String): String? = stored[key]

    override fun set(key: String, value: String) = write(key) { stored[key] = value }

    override fun delete(key: String) {
        stored.remove(key)
    }

    override fun update(key: String, change: (String?) -> String?) = write(key) { stored.compute(key) { _, before -> change(before) } }

    override fun subscribe(onChange: (key: String, value: String?) -> Unit): AutoCloseable? = null
}

/** Whether jo's `resource` key on kb-a holds the value of res-1 the gateway gave. */
private fun savedIn(storage: SessionStorage): Boolean {
    val document = storage.get(JO_RESOURCE_ON_A)?.let { wireJson.parseToJsonElement(it).jsonObject }
    return document?.getValue("entries")?.jsonArray.orEmpty().map { it.jsonArray }.any { entry ->
        entry[0].jsonPrimitive.content == "res-1" && entry[1].jsonObject.text("name") == "fresh"
    }
}

/**
 * Scripted sessions, each of kb-a's over a stored sign-in that names jo
 * writing under jo's `resource` key on kb-a as it closes, as a client of jo's
 * closing with a save owed could. One over another sign-in is no client of
 * jo's, and writes nothing as it closes.
 */
private class ClosingWrites(private val scripted: ScriptedSessions, private val storage: SessionStorage) : SessionFactory by scripted {
    override suspend fun session(options: SessionFactoryOptions): OpenedSession {
        val josClient = options.kb.id == KB_A && storedSession(storage, KB_A)?.personKey == JO
        val opened = scripted.session(options)
        if (!josClient) return opened
        val writesAsItCloses = AutoCloseable {
            opened.close()
            storage.set(JO_RESOURCE_ON_A, WRITTEN_CLOSING)
        }
        return OpenedSession(opened.session, writesAsItCloses) { opened.stopKeeping() }
    }
}

/** A collector of a resource's query, which holds the resource's scope until it is closed. */
private class Watching(client: SemiontClient, id: String, scope: CoroutineScope) : AutoCloseable {
    private val states = Channel<CacheState<ResourceDescriptor>>(Channel.UNLIMITED)
    private val collecting = scope.launch { client.browse.resource(ResourceId(id)).collect { states.send(it) } }

    /** `kept` when the first state given is what was kept, `fresh` when the first value given is the gateway's answer; otherwise, what was given. */
    suspend fun given(): String = withTimeout(10_000) {
        val shown = mutableListOf<CacheState<ResourceDescriptor>>()
        while (shown.lastOrNull() !is CacheState.Ready) shown += states.receive()
        val name = (shown.last() as CacheState.Ready).value.name
        when {
            name == "kept" && shown.size == 1 -> "kept"
            name == "fresh" -> "fresh"
            else -> "$shown"
        }
    }

    override fun close(): Unit = collecting.cancel()
}

/**
 * What a client keeps of one person, and when it is read, written and deleted
 * (protocol/specs/src/session/persisted-cases.json): the keys of each person,
 * what forgetting a saved sign-in deletes, whichever way it is forgotten, what
 * a registry's session over HTTP reads and records as it starts, what it
 * writes once another context has written its knowledge base's sign-in, and
 * what a script's session writes once its sign-in has been changed through
 * what holds it.
 */
class PersistedCasesTest {
    @Test
    fun theRunnerRunsEveryPartOfTheTable() {
        assertEquals(cases.filterValues { it is JsonArray }.keys, MEMBERS.keys)
    }

    @TestFactory
    fun eachPersonsKeysAreTheTables(): List<DynamicTest> = people.map { (name, person) ->
        DynamicTest.dynamicTest("the key of $name") { assertEquals(person.text("personKey"), personKey(person.text("did"))) }
    } + rows("keys").map { row ->
        DynamicTest.dynamicTest(row.text("why")) {
            read(row, "keys")
            val kbId = row.text("kbId")
            val person = personKey(row.text("did"))
            assertEquals(row.text("personKey"), person)
            assertEquals(row.text("lastEventIdKey"), lastEventIdKey(kbId, person))
            val stated = row.getValue("cacheKeys").jsonObject
            // The queries kept are exactly the row's, in its order.
            assertEquals(stated.keys.toList(), PERSISTED_QUERIES.map { it.wire })
            for (query in PERSISTED_QUERIES) assertEquals(stated.text(query.wire), cacheKey(kbId, person, query.wire), query.wire)
        }
    }

    @TestFactory
    fun forgettingASignInDeletesWhatTheTableSays(): List<DynamicTest> = rows("forget").map { row ->
        DynamicTest.dynamicTest(row.text("why")) { forget(row) }
    }

    @TestFactory
    fun aRegistrysSessionStartsAsTheTableSays(): List<DynamicTest> = rows("startup").map { row ->
        DynamicTest.dynamicTest(row.text("why")) { startup(row) }
    }

    @TestFactory
    fun aSignInAnotherContextWritesIsHeededAsTheTableSays(): List<DynamicTest> = rows("crossTab").map { row ->
        DynamicTest.dynamicTest(row.text("why")) { crossTab(row) }
    }

    @TestFactory
    fun aSignInChangedThroughWhatHoldsItIsHeededAsTheTableSays(): List<DynamicTest> = rows("holder").map { row ->
        DynamicTest.dynamicTest(row.text("why")) { holder(row) }
    }

    private fun forget(row: JsonObject) {
        read(row, "forget")
        when (val by = row.text("by")) {
            "signOut", "removal", "signIn" -> forgetByTheRegistry(row, by)
            "expiry", "refusal" -> forgetAsTheSessionEnds(row, by)
            else -> throw AssertionError("by $by is none the runner knows")
        }
    }

    /**
     * The registry signs out of kb-a, removes it, or signs in to it again with
     * a new sign-in. kb-a and kb-b are registered, and kb-b is active unless
     * the row has kb-a open: then kb-a's session, standing in for jo's client,
     * writes as it closes. After a new sign-in, kb-a's stored sign-in is it.
     */
    private fun forgetByTheRegistry(row: JsonObject, by: String): Unit = runBlocking {
        assertNull(row["stored"], "a $by row states no token")
        val storage = MemoryStorage()
        for ((key, value) in FORGET_STORAGE) storage.set(key, value)
        saveKnowledgeBases(storage, listOf(kbOfA(), kbOfB()))
        val open = row.getValue("open").jsonPrimitive.boolean
        storage.set(ACTIVE_KEY, if (open) KB_A else KB_B)
        signInOf(row) { person -> tokens("r").copy(personKey = person) }?.let { storeSession(storage, KB_A, it) }
        val scripted = ScriptedSessions().also { it.saysWho(wireJson.decodeFromJsonElement(UserResponse.serializer(), whoAmI)) }
        SemiontBrowser(SemiontBrowserConfig(storage, ClosingWrites(scripted, storage))).use { browser ->
            if (open) assertEquals(KB_A, live(browser).kb.id)
            when (by) {
                "signOut" -> browser.signOut(KB_A)
                "removal" -> browser.removeKb(KB_A)
                "signIn" -> {
                    val replacing = tokens("r-new", tokenFor("new"))
                    browser.signIn(KB_A, replacing)
                    assertEquals(replacing, storedSession(storage, KB_A), "kb-a's stored sign-in is the new one")
                }
            }
        }
        forgotten(row, storage)
    }

    /**
     * kb-a's session, the registry's own over HTTP, finds the token the row
     * says, and its gateway and issuer answer so that it ends: the issuer
     * refusing to renew the token (`expiry`), or the gateway refusing the token
     * the issuer renewed (`refusal`). It ends as it starts, so the registry
     * shows it once its sign-in is forgotten.
     */
    private fun forgetAsTheSessionEnds(row: JsonObject, by: String): Unit = runBlocking {
        assertTrue(row.getValue("open").jsonPrimitive.boolean, "a session that ends is kb-a's active one")
        Realm().use { realm ->
            val access = when (val stored = row.text("stored")) {
                // Renewed before the gateway is asked.
                "expired" -> tokenFor("access", -10)
                // Renewed once the gateway refuses it.
                "unexpired" -> tokenFor("access").also { realm.script(WHO, REFUSED) }
                else -> throw AssertionError("stored $stored is none the runner knows")
            }
            when (by) {
                "expiry" -> realm.script("/token", NOT_RENEWED)
                "refusal" -> {
                    realm.script("/token", issued(tokenFor("renewed"), "r2"))
                    realm.script(WHO, REFUSED)
                }
            }
            val storage = MemoryStorage()
            for ((key, value) in FORGET_STORAGE) storage.set(key, value)
            saveKnowledgeBases(storage, listOf(realm.kbA()))
            storage.set(ACTIVE_KEY, KB_A)
            val signIn = checkNotNull(signInOf(row) { person -> realm.signIn(person, access) }) { "a session over nothing stored has no sign-in to forget" }
            storeSession(storage, KB_A, signIn)
            SemiontBrowser(SemiontBrowserConfig(storage, HttpSessionFactory())).use { browser ->
                live(browser)
                assertNull(storedSession(storage, KB_A), "kb-a's session ended without forgetting its sign-in")
            }
            forgotten(row, storage)
        }
    }

    /** Once kb-a's client has closed: what the row removes holds nothing, and every other key of `forgetStorage` holds what it held. */
    private fun forgotten(row: JsonObject, storage: SessionStorage) {
        val removed = when (val removes = row.text("removes")) {
            "person" -> JO_ON_A
            "nothing" -> emptySet()
            else -> throw AssertionError("removes $removes is none the runner knows")
        }
        for (key in removed) assertNull(storage.get(key), key)
        for ((key, value) in FORGET_STORAGE) if (key !in removed) assertEquals(value, storage.get(key), key)
    }

    /**
     * The session the registry's factory over HTTP builds, held as the factory
     * gives it: a registry shows a session only once it is ready, and `first`
     * is asked before.
     */
    private fun startup(row: JsonObject): Unit = runBlocking {
        read(row, "startup")
        Realm().use { realm ->
            realm.answersFresh()
            realm.hold(WHO)
            val kept = storedOf("startupStorage")
            val storage = ListedStorage()
            for ((key, value) in kept) storage.set(key, value)
            val signedIn = when (val stated = row.text("signedIn")) {
                "named" -> JO
                "unnamed" -> null
                else -> throw AssertionError("signedIn $stated is none the runner knows")
            }
            storeSession(storage, KB_A, realm.signIn(signedIn))
            SessionSignals().use { signals ->
                HttpSessionFactory().session(SessionFactoryOptions(realm.kbA(), storage, signals) {}).use { opened ->
                    eventually("the gateway is asked who the token is") { realm.of(WHO).isNotEmpty() }
                    assertEquals(row.text("first"), Watching(opened.client, "res-2", this).use { it.given() }, "first")
                    when (val gateway = row.text("gateway")) {
                        "names" -> realm.release(WHO, Said(200, whoAmI))
                        "unreachable" -> {
                            // A request the gateway could not answer is made once more, and is not answered either.
                            realm.script(WHO, UNAVAILABLE)
                            realm.release(WHO, UNAVAILABLE)
                        }
                        else -> throw AssertionError("gateway $gateway is none the runner knows")
                    }
                    withTimeout(10_000) { opened.session.ready() }
                    assertEquals(row.textOrNull("recorded"), storedSession(storage, KB_A)?.personKey, "recorded")
                    Watching(opened.client, "res-1", this).use { watching ->
                        assertEquals(row.text("then"), watching.given(), "then")
                        eventually("a stream names res-1") { realm.scoped("res-1") != null }
                        assertEquals(row.textOrNull("place"), realm.scoped("res-1")?.textOrNull("lastEventId"), "place")
                    }
                }
            }
            if (row["untouched"]?.jsonPrimitive?.boolean == true) {
                for ((key, value) in kept) assertEquals(value, storage.get(key), key)
                assertEquals(kept.keys, storage.keys().filter { key -> prefixes.any { key.startsWith(it) } }.toSet())
            }
        }
    }

    /** kb-a is the registry's active knowledge base; the other context writes its sign-in through a context of its own over the same storage. */
    private fun crossTab(row: JsonObject): Unit = runBlocking {
        read(row, "crossTab")
        Realm().use { realm ->
            realm.answersFresh()
            repeat(10) { realm.script(WHO, Said(200, whoAmI)) }
            val storage = SharedStorage()
            saveKnowledgeBases(storage, listOf(realm.kbA()))
            storeSession(storage, KB_A, realm.signIn(JO))
            SemiontBrowser(SemiontBrowserConfig(storage, HttpSessionFactory())).use { browser ->
                val client = live(browser).client
                assertEquals("fresh", Watching(client, "res-1", this).use { it.given() })
                // The table's state holds only while the client has not yet written what it holds of res-1: its write waits
                // for a pause, and nothing here waits.
                assertNull(storage.get(JO_RESOURCE_ON_A), "the client wrote res-1 before the other context wrote its sign-in")
                val elsewhere = storage.context()
                when (val stored = row.getValue("stored")) {
                    is JsonNull -> clearStoredSession(elsewhere, KB_A)
                    else -> when (val person = stored.jsonObject.textOrNull("personKey")) {
                        // The same person's: the sign-in renewed there, with other tokens.
                        JO -> keptIn(elsewhere, KB_A).let { kept -> kept.renewed(checkNotNull(kept.held()), tokenFor("another"), "r-another") }
                        else -> storeSession(elsewhere, KB_A, realm.signIn(person, tokenFor("another"), "r-another"))
                    }
                }
            }
            assertEquals(row.getValue("saved").jsonPrimitive.boolean, savedIn(storage), "saved")
        }
    }

    /**
     * kb-a's session as a script makes it, over a memory sign-in naming jo, its
     * caches kept in a storage of their own; the sign-in is changed through the
     * memory sign-in, in this process: forgotten, a new sign-in kept in its
     * place, or renewed.
     */
    private fun holder(row: JsonObject): Unit = runBlocking {
        read(row, "holder")
        Realm().use { realm ->
            realm.answersFresh()
            repeat(10) { realm.script(WHO, Said(200, whoAmI)) }
            val storage = MemoryStorage()
            val kept = MemorySignIn(realm.held(JO))
            sessionFromKept(realm.targetA(), kept, storage = storage).use { opened ->
                assertEquals("fresh", Watching(opened.client, "res-1", this).use { it.given() })
                // The table's state holds only while the client has not yet written what it holds of res-1: its write waits
                // for a pause, and nothing here waits.
                assertNull(storage.get(JO_RESOURCE_ON_A), "the client wrote res-1 before its sign-in was changed")
                when (val stored = row.getValue("stored")) {
                    is JsonNull -> kept.forget()
                    else -> when (val person = stored.jsonObject.textOrNull("personKey")) {
                        JO -> kept.renewed(checkNotNull(kept.held()), tokenFor("another"), "r-another")
                        else -> kept.keep(realm.held(person, tokenFor("another"), "r-another"))
                    }
                }
            }
            assertEquals(row.getValue("saved").jsonPrimitive.boolean, savedIn(storage), "saved")
        }
    }

    /**
     * No save lands after the delete: kb-a's session, the registry's own over
     * HTTP, keeps for jo, and its client's write of what it holds of res-1 has
     * begun, past whatever it is checked against, and waits. Meanwhile the
     * issuer refuses the session's renewal, so the session forgets its sign-in,
     * and with it what was kept for jo. Once the write is let go and both are
     * done, and once the client has closed, nothing is kept for jo on kb-a.
     */
    @Test
    fun aWriteUnderWayAsTheSessionForgetsItsSignInDoesNotLandAfterTheDelete(): Unit = runBlocking {
        Realm().use { realm ->
            realm.answersFresh()
            repeat(10) { realm.script(WHO, Said(200, whoAmI)) }
            val storage = HeldWrite(JO_RESOURCE_ON_A)
            storeSession(storage, KB_A, realm.signIn(JO))
            SessionSignals().use { signals ->
                HttpSessionFactory().session(SessionFactoryOptions(realm.kbA(), storage, signals) {}).use { opened ->
                    val session = opened.session
                    withTimeout(10_000) { session.ready() }
                    assertEquals("fresh", Watching(opened.client, "res-1", this).use { it.given() })
                    withTimeout(10_000) { storage.entered.await() }
                    realm.script("/token", NOT_RENEWED)
                    // Off this thread: a forget that waits for the write must not keep the test from letting it go.
                    val holding = session.token.value
                    val forgetting = CoroutineScope(Dispatchers.IO).async { session.refresh(holding) }
                    eventually("the issuer refused the session's renewal") { realm.of("/token").isNotEmpty() && session.token.value == null }
                    // The forget follows at once: it is done, or it waits for the write.
                    withTimeoutOrNull(200) { forgetting.await() }
                    assertFalse(storage.landed.isCompleted, "the write landed before the session forgot its sign-in")
                    storage.release()
                    assertNull(withTimeout(10_000) { forgetting.await() }, "the session holds a token its issuer refused to renew")
                    withTimeout(10_000) { storage.landed.await() }
                    assertNull(storedSession(storage, KB_A), "the session ended without forgetting its sign-in")
                    for (key in JO_ON_A) assertNull(storage.get(key), key)
                }
            }
            for (key in JO_ON_A) assertNull(storage.get(key), key)
        }
    }
}
