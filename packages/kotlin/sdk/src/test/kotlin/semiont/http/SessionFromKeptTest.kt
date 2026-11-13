package semiont.http

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import semiont.ClientTiming
import semiont.cache.CacheState
import semiont.cache.PERSISTED_QUERIES
import semiont.errors.SemiontError
import semiont.errors.SessionError
import semiont.errors.SessionErrorCode
import semiont.identifiers.ResourceId
import semiont.live.RESOURCE
import semiont.live.recorded
import semiont.registry.StoredSession
import semiont.registry.answersFresh
import semiont.registry.cacheKey
import semiont.registry.keptIn
import semiont.registry.lastEventIdKey
import semiont.registry.personKey
import semiont.registry.storeSession
import semiont.session.SessionEndReason
import semiont.signin.HeldSignIn
import semiont.signin.MemorySignIn
import semiont.signin.SCRIPT_CLIENT_ID
import semiont.signin.SignInKept
import semiont.storage.CoupledBookmarks
import semiont.storage.MemoryStorage
import semiont.storage.SessionStorage
import semiont.types.HttpEndpoint
import semiont.types.HttpEndpointProtocol
import semiont.types.KbTarget
import semiont.types.LocalEndpoint
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random
import kotlin.time.TimeSource

private val alice = Json.parseToJsonElement(
    """{"did":"did:web:example.org:users:alice","email":"alice@example.org","name":"Alice","image":null,"domain":"example.org","isAdmin":false,"isModerator":false,"termsAcceptedAt":null}""",
).jsonObject

private val refused = buildJsonObject { put("error", "invalid_token") }

/** The key Alice's caches are kept under, and what is kept of res-1 for her on the knowledge base `local`. */
private val ALICE_KEY = personKey(alice.getValue("did").jsonPrimitive.content)
private val KEPT_FOR_ALICE = cacheKey("local", ALICE_KEY, "resource") to
    """{"version":1,"entries":[["res-1",{"@context":"https://schema.org/","@id":"res-1","name":"kept","representations":[]},1700000000000]]}"""

/** `beneath`, whose sign-in cannot be read while `unreadable` holds. */
private class Unreadable(private val beneath: SignInKept) : SignInKept by beneath {
    @Volatile
    var unreadable = false

    /** How often it was asked while it could not be read. */
    val refused = AtomicInteger()

    override suspend fun held(): HeldSignIn? {
        if (unreadable) {
            refused.incrementAndGet()
            throw IOException("the sign-in cannot be read")
        }
        return beneath.held()
    }
}

/** `beneath`, whose sign-in can be read `reads` times, and not after. */
private class ReadableFor(private val reads: Int, private val beneath: SignInKept) : SignInKept by beneath {
    private val read = AtomicInteger()

    override suspend fun held(): HeldSignIn? {
        if (read.incrementAndGet() > reads) throw IOException("the sign-in cannot be read")
        return beneath.held()
    }
}

/** `beneath`, which cannot record who a gateway said its token is. */
private class Unrecording(private val beneath: SignInKept) : SignInKept by beneath {
    override suspend fun recordPersonKey(access: String, personKey: String): Boolean = throw IOException("the person cannot be recorded")
}

/** A sign-in whose reading waits, while `gate` is set, until it completes. */
private class Waiting(private val beneath: SignInKept) : SignInKept by beneath {
    @Volatile
    var gate: CompletableDeferred<Unit>? = null

    /** How often it was read while its reading waited. */
    val waited = AtomicInteger()

    override suspend fun held(): HeldSignIn? {
        gate?.let {
            waited.incrementAndGet()
            it.await()
        }
        return beneath.held()
    }
}

/** A storage that refuses its first write of `refused`, keeping nothing of it, and takes every other write as `beneath` does. */
private class RefusingTheFirstWriteOf(private val beneath: SessionStorage, private val refused: String) : SessionStorage by beneath {
    /** How many writes it has refused: one, once it has. */
    val refusals = AtomicInteger()

    private fun refuses(key: String): Boolean = key == refused && refusals.compareAndSet(0, 1)

    override fun set(key: String, value: String) {
        if (refuses(key)) throw IOException("the storage refuses the write of $refused")
        beneath.set(key, value)
    }

    override fun update(key: String, change: (String?) -> String?) {
        if (refuses(key)) throw IOException("the storage refuses the write of $refused")
        beneath.update(key, change)
    }
}

/** A storage that refuses every write of `refused`, keeping nothing of it, and takes every other write as `beneath` does. */
private class RefusingEveryWriteOf(private val beneath: SessionStorage, private val refused: String) : SessionStorage by beneath {
    /** How many writes it has refused. */
    val refusals = AtomicInteger()

    private fun refuse(key: String) {
        if (key != refused) return
        refusals.incrementAndGet()
        throw IOException("the storage refuses the write of $refused")
    }

    override fun set(key: String, value: String) {
        refuse(key)
        beneath.set(key, value)
    }

    override fun update(key: String, change: (String?) -> String?) {
        refuse(key)
        beneath.update(key, change)
    }
}

/** A random source whose every draw is the lowest it can give: each jittered wait is as short as it can be. */
private object LowestDraw : Random() {
    override fun nextBits(bitCount: Int): Int = 0
}

/** Whether a stream's subscription holds the scope of `resource`: one that names no scopes holds none. */
private fun holdsTheScopeOf(subscription: JsonObject, resource: String): Boolean =
    (subscription["scoped"] as? JsonArray)?.any { it.jsonObject.getValue("scope").jsonPrimitive.content == resource } == true

/** A session over HTTP from a kept sign-in: opened, renewed through itself, keeping its caches for the person its gateway names, and closed with what it opened. */
class SessionFromKeptTest {
    private fun kb(realm: Realm) = KbTarget(id = "local", label = "Local", endpoint = HttpEndpoint(host = "127.0.0.1", port = realm.origin.substringAfterLast(':').toLong(), protocol = HttpEndpointProtocol.Http))

    @Test
    fun aTokenTheGatewayRefusesAsTheSessionStartsIsRenewedThroughTheSession() = runBlocking {
        Realm().use { realm ->
            val stored = tokenFor("access-1")
            val renewed = tokenFor("access-2")
            // The stream and the ask are both refused the kept token; each is answered by the session's one renewal.
            realm.script("/bus/subscribe", Said(401, refused))
            realm.script("/api/users/me", Said(401, refused), Said(200, alice))
            realm.script("/token", issued(renewed, "refresh-2"))
            val kept = MemorySignIn(HeldSignIn(stored, "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, null))
            sessionFromKept(kb(realm), kept).use { opened ->
                assertEquals(renewed, opened.session.token.value)
                assertEquals("alice@example.org", opened.session.user.value?.email)
                assertEquals(listOf("refresh-1"), realm.of("/token").map { it.form["refresh_token"] })
                assertEquals(renewed, kept.held()?.access)
                // A session given no storage keeps nothing, and records nobody.
                assertNull(kept.held()?.personKey)
            }
        }
    }

    @Test
    fun aSessionGivenItsCallersClientAsksTheGatewayAndTheIssuerWithIt() = runBlocking {
        Realm().use { realm ->
            val renewed = tokenFor("access-2")
            realm.script("/api/users/me", Said(401, refused), Said(200, alice))
            realm.script("/token", issued(renewed, "refresh-2"))
            val kept = MemorySignIn(HeldSignIn(tokenFor("access-1"), "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, null))
            val http = CallersHttp()
            sessionFromKept(kb(realm), kept, http = http).use { opened ->
                assertEquals(renewed, opened.session.token.value)
                withTimeout(5_000) {
                    while (realm.of("/bus/subscribe").isEmpty()) delay(5)
                }
            }
            assertTrue(http.made.containsAll(listOf("/api/users/me", "/token", "/bus/subscribe")), "${http.made}")
            realm.askedOnlyThrough(http)
        }
    }

    @Test
    fun aRefusalOfTheStreamBeforeTheSessionExistsIsRenewedByTheSession() = runBlocking {
        Realm().use { realm ->
            val stored = tokenFor("access-1")
            val renewed = tokenFor("access-2")
            // The gateway knows who the kept token is, and its stream refuses it: only the transport's refresher, which
            // the stream asks before the session it refreshes through exists, renews it.
            realm.script("/bus/subscribe", Said(401, refused))
            realm.script("/api/users/me", Said(200, alice), Said(200, alice))
            realm.script("/token", issued(renewed, "refresh-2"))
            val kept = MemorySignIn(HeldSignIn(stored, "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, null))
            sessionFromKept(kb(realm), kept).use { opened ->
                withTimeout(10_000) { opened.session.token.first { it == renewed } }
                assertEquals(listOf("refresh-1"), realm.of("/token").map { it.form["refresh_token"] })
            }
        }
    }

    @Test
    fun aSessionGivenAStorageRecordsWhoTheGatewayNamesOnItsSignInAndThenShowsWhatWasKeptForThem() = runBlocking {
        Realm().use { realm ->
            realm.script("/api/users/me", Said(200, alice))
            val storage = MemoryStorage()
            storage.set(KEPT_FOR_ALICE.first, KEPT_FOR_ALICE.second)
            // A sign-in whose person no gateway has named yet.
            val kept = MemorySignIn(HeldSignIn(tokenFor("access-1"), "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, null))
            sessionFromKept(kb(realm), kept, storage = storage).use { opened ->
                assertEquals(ALICE_KEY, kept.held()?.personKey)
                // What was kept for them is shown at once.
                val shown = withTimeout(5_000) { opened.client.browse.resource(ResourceId("res-1")).first() }
                assertEquals("kept", (shown as? CacheState.Ready)?.value?.name, "$shown")
            }
        }
    }

    @Test
    fun aSessionOverTheRegistrysKeptSignInPutsNothingBackOnceItIsForgotten() = runBlocking {
        Realm().use { realm ->
            realm.answersFresh()
            realm.script("/api/users/me", Said(200, alice))
            val storage = MemoryStorage()
            storeSession(storage, "local", StoredSession(tokenFor("access-1"), "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, ALICE_KEY))
            val kept = keptIn(storage, "local")
            sessionFromKept(kb(realm), kept, storage = storage).use { opened ->
                val shown = withTimeout(5_000) { opened.client.browse.resource(ResourceId("res-1")).first { it is CacheState.Ready } }
                assertEquals("fresh", (shown as? CacheState.Ready)?.value?.name, "$shown")
                // What the client holds of res-1 is written after a pause, and nothing here waits: its close owes it.
                assertNull(storage.get(KEPT_FOR_ALICE.first), "the client wrote res-1 before its sign-in was forgotten")
                kept.forget()
            }
            assertNull(storage.get(KEPT_FOR_ALICE.first))
        }
    }

    @Test
    fun aWriteOfWhatTheClientKeepsThatTheStorageRefusesHasNoPlaceWrittenAfterIt() = runBlocking {
        Realm().use { realm ->
            realm.answersFresh()
            realm.script("/api/users/me", Said(200, alice))
            val places = lastEventIdKey("local", ALICE_KEY)
            val storage = RefusingTheFirstWriteOf(MemoryStorage(), KEPT_FOR_ALICE.first)
            val kept = MemorySignIn(HeldSignIn(tokenFor("access-1"), "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, ALICE_KEY))
            sessionFromKept(kb(realm), kept, storage = storage).use { opened ->
                val transport = opened.client.transport
                val heard = transport.frames("mark:added")
                transport.subscribeToResource(ResourceId("res-1")).use {
                    withTimeout(5_000) {
                        while (realm.subscriptions.none { holdsTheScopeOf(it, "res-1") }) delay(5)
                    }
                    // A recorded event of res-1, which asks again for nothing the client holds: its id is the scope's place.
                    realm.send(JsonObject(mapOf("channel" to JsonPrimitive("mark:added"), "payload" to recorded("mark:added", RESOURCE), "scope" to JsonPrimitive("res-1"))), "p-res-1-9")
                    withTimeout(5_000) { heard.firstOf(1) }
                    // Then res-1 is read, and the save its answer owes is refused.
                    withTimeout(5_000) { opened.client.browse.resource(ResourceId("res-1")).first { it is CacheState.Ready } }
                    withTimeout(5_000) {
                        while (storage.refusals.get() == 0) delay(5)
                    }
                    delay(semiont.Timings.SAVE_DEBOUNCE_MS * 4)
                    // The cache kept nothing of what the place names, so no place says it did.
                    assertNull(storage.get(places), "a place was written after the write of res-1 was refused")
                }
            }
        }
    }

    @Test
    fun aWriteThatWaitedForItsTurnAndIsRefusedIsOwedSoNoPlaceIsWrittenAheadOfItAndClosingMakesIt() = runBlocking {
        Realm().use { realm ->
            realm.answersFresh()
            realm.script("/api/users/me", Said(200, alice))
            realm.script("/resources/res-1/annotations", Said(200, Json.parseToJsonElement("""{"annotations":[],"total":0}""").jsonObject))
            val places = lastEventIdKey("local", ALICE_KEY)
            val annotations = cacheKey("local", ALICE_KEY, "annotations")
            val storage = RefusingTheFirstWriteOf(MemoryStorage(), KEPT_FOR_ALICE.first)
            val kept = Waiting(MemorySignIn(HeldSignIn(tokenFor("access-1"), "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, ALICE_KEY)))
            sessionFromKept(kb(realm), kept, storage = storage).use { opened ->
                val client = opened.client
                val transport = client.transport
                val heard = transport.frames("mark:added")
                transport.subscribeToResource(ResourceId("res-1")).use {
                    withTimeout(5_000) {
                        while (realm.subscriptions.none { holdsTheScopeOf(it, "res-1") }) delay(5)
                    }
                    // A recorded event of res-1, which asks again for nothing the client holds: its id is the scope's place.
                    realm.send(JsonObject(mapOf("channel" to JsonPrimitive("mark:added"), "payload" to recorded("mark:added", RESOURCE), "scope" to JsonPrimitive("res-1"))), "p-res-1-9")
                    withTimeout(5_000) { heard.firstOf(1) }
                    // The sign-in's reading waits, so the write res-1's answer owes waits for its turn, and its cache goes on.
                    val gate = CompletableDeferred<Unit>()
                    kept.gate = gate
                    withTimeout(5_000) { client.browse.resource(ResourceId("res-1")).first { it is CacheState.Ready } }
                    withTimeout(5_000) {
                        while (kept.waited.get() == 0) delay(5)
                    }
                    kept.gate = null
                    gate.complete(Unit)
                    withTimeout(5_000) {
                        while (storage.refusals.get() == 0) delay(5)
                    }
                    // Refused once its cache went on, the write is owed still, and the client is not at rest.
                    withTimeout(5_000) {
                        while (client.persistenceSettled) delay(5)
                    }
                    // Another kept cache's write is made, and no place rides it ahead of the write still owed.
                    withTimeout(5_000) { client.browse.annotations(ResourceId("res-1")).first { it is CacheState.Ready } }
                    withTimeout(5_000) {
                        while (storage.get(annotations) == null) delay(5)
                    }
                    assertNull(storage.get(places), "a place was written while the refused write of res-1 was owed")
                    assertNull(storage.get(KEPT_FOR_ALICE.first))
                }
            }
            // Closing makes the write that was owed, and the place rides it.
            withTimeout(5_000) {
                while (storage.get(KEPT_FOR_ALICE.first) == null) delay(5)
            }
            withTimeout(5_000) {
                while (storage.get(places) == null) delay(5)
            }
            assertEquals(mapOf(ResourceId("res-1") to "p-res-1-9"), CoupledBookmarks(storage, places).load())
        }
    }

    @Test
    fun aWriteThatWaitedForItsTurnAndIsRefusedIsSaidOnTheSessionsErrorsAndThrownIntoNoScope() = runBlocking {
        Realm().use { realm ->
            realm.answersFresh()
            realm.script("/api/users/me", Said(200, alice))
            val storage = RefusingTheFirstWriteOf(MemoryStorage(), KEPT_FOR_ALICE.first)
            val kept = Waiting(MemorySignIn(HeldSignIn(tokenFor("access-1"), "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, ALICE_KEY)))
            val uncaught = CopyOnWriteArrayList<Throwable>()
            val context = Dispatchers.Default + CoroutineExceptionHandler { _, thrown -> uncaught += thrown }
            val opened = sessionFromKept(kb(realm), kept, storage = storage, context = context)
            val said = CopyOnWriteArrayList<SemiontError>()
            val errors = opened.session.errors()
            val listening = launch(Dispatchers.Unconfined) { errors.collect { said += it } }
            val refusal = "the storage refuses the write of ${KEPT_FOR_ALICE.first}"
            opened.use {
                // The sign-in's reading waits, so the write res-1's answer owes waits for its turn, and its cache goes on.
                val gate = CompletableDeferred<Unit>()
                kept.gate = gate
                withTimeout(5_000) { opened.client.browse.resource(ResourceId("res-1")).first { it is CacheState.Ready } }
                withTimeout(5_000) {
                    while (kept.waited.get() == 0) delay(5)
                }
                kept.gate = null
                gate.complete(Unit)
                withTimeout(5_000) {
                    while (storage.refusals.get() == 0) delay(5)
                }
                // Its cache went on before the storage refused it: the refusal is the session's to say.
                withTimeout(5_000) {
                    while (said.none { refusal in it.message }) delay(5)
                }
            }
            withTimeout(5_000) { listening.join() }
            assertEquals(listOf(SessionErrorCode.SaveRefused.code), said.filter { refusal in it.message }.map { it.code }, "$said")
            assertEquals(emptyList<Throwable>(), uncaught.toList())
        }
    }

    @Test
    fun aWriteTheStorageRefusesIsSaidOnceAsRefusedAndStaysOwedForTheClosingToMake() = runBlocking {
        Realm().use { realm ->
            realm.answersFresh()
            realm.script("/api/users/me", Said(200, alice))
            val storage = RefusingTheFirstWriteOf(MemoryStorage(), KEPT_FOR_ALICE.first)
            val kept = MemorySignIn(HeldSignIn(tokenFor("access-1"), "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, ALICE_KEY))
            val opened = sessionFromKept(kb(realm), kept, storage = storage)
            val said = CopyOnWriteArrayList<SemiontError>()
            val errors = opened.session.errors()
            val listening = launch(Dispatchers.Unconfined) { errors.collect { said += it } }
            opened.use {
                withTimeout(5_000) { opened.client.browse.resource(ResourceId("res-1")).first { it is CacheState.Ready } }
                withTimeout(5_000) {
                    while (said.none { it is SessionError }) delay(5)
                }
                // Said as the storage refused it, in the storage's words, and owed still: the client is not at rest.
                val refused = said.filterIsInstance<SessionError>().single()
                assertEquals(SessionErrorCode.SaveRefused to "local", refused.reason to refused.kbId)
                assertTrue("the storage refuses the write of ${KEPT_FOR_ALICE.first}" in refused.message, refused.message)
                assertFalse(opened.client.persistenceSettled)
                assertNull(storage.get(KEPT_FOR_ALICE.first))
            }
            withTimeout(5_000) { listening.join() }
            // The closing flush made the write that was owed, before the errors ended, and nothing more was said.
            assertNotNull(storage.get(KEPT_FOR_ALICE.first))
            assertEquals(1, storage.refusals.get())
            assertEquals(listOf(SessionErrorCode.SaveRefused), said.filterIsInstance<SessionError>().map { it.reason }, "$said")
        }
    }

    @Test
    fun aWriteTheClosingFlushCannotMakeIsSaidOnceMoreBeforeTheSessionsErrorsEnd() = runBlocking {
        Realm().use { realm ->
            realm.answersFresh()
            realm.script("/api/users/me", Said(200, alice))
            val storage = RefusingEveryWriteOf(MemoryStorage(), KEPT_FOR_ALICE.first)
            val kept = MemorySignIn(HeldSignIn(tokenFor("access-1"), "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, ALICE_KEY))
            val opened = sessionFromKept(kb(realm), kept, storage = storage)
            val errors = opened.session.errors()
            opened.use {
                withTimeout(5_000) { opened.client.browse.resource(ResourceId("res-1")).first { it is CacheState.Ready } }
                withTimeout(5_000) {
                    while (storage.refusals.get() == 0) delay(5)
                }
            }
            // The closing flush made the write it owed, which the storage still refused: that is said, and then the errors end.
            val said = withTimeout(5_000) { errors.toList() }
            assertEquals(listOf(SessionErrorCode.SaveRefused, SessionErrorCode.SaveRefused), said.filterIsInstance<SessionError>().map { it.reason }, "$said")
            assertEquals(2, storage.refusals.get())
            assertNull(storage.get(KEPT_FOR_ALICE.first))
        }
    }

    @Test
    fun aSaveOwedAsTheClientClosesThatTheStorageRefusesIsAskedForOnceAndSaidOnce() = runBlocking {
        Realm().use { realm ->
            realm.answersFresh()
            realm.script("/api/users/me", Said(200, alice))
            val storage = RefusingEveryWriteOf(MemoryStorage(), KEPT_FOR_ALICE.first)
            val kept = MemorySignIn(HeldSignIn(tokenFor("access-1"), "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, ALICE_KEY))
            // Its caches wait an hour after they last change before they save: its closing is the first to make the save one owes.
            val timing = ClientTiming(saveDebounceMs = TimeUnit.HOURS.toMillis(1))
            val opened = sessionStarted(kb(realm), kept, true, storage, null, ownHttp, Dispatchers.Default, TimeSource.Monotonic, Random.Default, timing)
            val errors = opened.session.errors()
            opened.use {
                opened.session.ready()
                withTimeout(5_000) { opened.client.browse.resource(ResourceId("res-1")).first { it is CacheState.Ready } }
                assertFalse(opened.client.persistenceSettled, "the client owes no save")
                assertEquals(0, storage.refusals.get())
            }
            // The closing flush asked the storage for the save once, and it was refused: that is said once, and the save is lost.
            val said = withTimeout(5_000) { errors.toList() }
            assertEquals(listOf(SessionErrorCode.SaveRefused), said.filterIsInstance<SessionError>().map { it.reason }, "$said")
            assertEquals(1, storage.refusals.get())
            assertNull(storage.get(KEPT_FOR_ALICE.first))
        }
    }

    @Test
    fun aRenewalOnTheBackoffIsHandedTheTokenTheGatewayRefusedSoTheIssuerIsAsked() = runBlocking {
        Realm().use { realm ->
            realm.script("/api/users/me", Said(200, alice))
            val access = tokenFor("access-1")
            val renewed = tokenFor("access-2")
            // The issuer does not answer the renewal of the refused token, through its whole retry budget, and then renews it.
            repeat(semiont.Timings.REFRESH_RETRY.attempts) { realm.script("/token", Said(503, buildJsonObject { put("error", "unavailable") })) }
            realm.script("/token", issued(renewed, "refresh-2"))
            val kept = MemorySignIn(HeldSignIn(access, "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, null))
            sessionFromKept(kb(realm), kept, random = LowestDraw).use { opened ->
                val session = opened.session
                session.errors().use { errors ->
                    // The gateway refused the token the session holds, which has not expired, and its renewal got no answer.
                    assertNull(session.refresh(access))
                    assertEquals(SessionErrorCode.RefreshExhausted, withTimeout(5_000) { errors.filterIsInstance<SessionError>().first() }.reason)
                }
                assertEquals(access, kept.held()?.access)
                // The renewal on the reconnect backoff is handed the token that renewal was for, the one kept, which the
                // gateway refused: so the issuer is asked, and its new token is the session's, not the refused one.
                withTimeout(15_000) { session.token.first { it == renewed } }
                assertEquals(semiont.Timings.REFRESH_RETRY.attempts + 1, realm.of("/token").size)
                assertEquals(renewed, kept.held()?.access)
            }
        }
    }

    @Test
    fun aSessionThatClosesWhileItsTokenIsRenewedKeepsWhatTheIssuerRotatedAndGivesTheRefusalNoToken() = runBlocking {
        Realm().use { realm ->
            realm.script("/api/users/me", Said(200, alice))
            val access = tokenFor("access-1")
            val renewed = tokenFor("access-2")
            val kept = MemorySignIn(HeldSignIn(access, "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, null))
            val ended = CopyOnWriteArrayList<SessionEndReason>()
            sessionFromKept(kb(realm), kept, onAuthFailed = { ended += it }).use { opened ->
                val session = opened.session
                // The issuer holds its answer to the refusal's renewal while the session closes.
                realm.hold("/token")
                val refusing = async { session.refresh(access) }
                withTimeout(5_000) {
                    while (realm.of("/token").isEmpty()) delay(5)
                }
                val closing = async(Dispatchers.Default) { opened.close() }
                // The close gives the refusal no token at once, rather than a cancellation it never had, and waits for the renewal.
                assertNull(withTimeout(5_000) { refusing.await() })
                assertFalse(closing.isCompleted)
                assertEquals("refresh-1", kept.held()?.refresh)
                realm.release("/token", issued(renewed, "refresh-2"))
                withTimeout(5_000) { closing.await() }
                // The close returned once the renewal had ended: what the issuer rotated is kept, the closed session took
                // none of it and asked the gateway nothing with it, and nobody was signed out.
                assertEquals(renewed to "refresh-2", kept.held()?.let { it.access to it.refresh })
                assertEquals(access, session.token.value)
                assertEquals(listOf("Bearer $access"), realm.of("/api/users/me").map { it.authorization })
                assertEquals(emptyList<SessionEndReason>(), ended)
                // A closed session gives no token, whatever token was refused, and asks the issuer for nothing.
                assertNull(session.refresh(access))
                assertNull(session.refresh(renewed))
                assertEquals(1, realm.of("/token").size)
            }
        }
    }

    @Test
    fun aSignInThatCannotBeReadAsTheClientSavesStopsItsKeepingAndTheSessionSaysSoOnceOnItsErrors() = runBlocking {
        Realm().use { realm ->
            realm.answersFresh()
            realm.script("/api/users/me", Said(200, alice))
            val storage = MemoryStorage()
            val kept = Unreadable(MemorySignIn(HeldSignIn(tokenFor("access-1"), "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, ALICE_KEY)))
            val opened = sessionFromKept(kb(realm), kept, storage = storage)
            val told = CopyOnWriteArrayList<SessionError>()
            val errors = opened.session.errors()
            val listening = launch(Dispatchers.Unconfined) { errors.collect { if (it is SessionError) told += it } }
            opened.use {
                kept.unreadable = true
                withTimeout(5_000) { opened.client.browse.resource(ResourceId("res-1")).first { it is CacheState.Ready } }
                withTimeout(5_000) {
                    while (told.isEmpty()) delay(5)
                }
                // Readable again, it is not asked again: the client keeps nothing more for the rest of its life.
                kept.unreadable = false
                withTimeout(5_000) { opened.client.browse.resource(ResourceId("res-2")).first { it is CacheState.Ready } }
                delay(semiont.Timings.SAVE_DEBOUNCE_MS * 4)
            }
            withTimeout(5_000) { listening.join() }
            assertEquals(listOf(SessionErrorCode.KeepFailed), told.map { it.reason })
            assertEquals("local", told.single().kbId)
            assertEquals(1, kept.refused.get())
            for (key in PERSISTED_QUERIES.map { cacheKey("local", ALICE_KEY, it.query.wire) } + lastEventIdKey("local", ALICE_KEY)) assertNull(storage.get(key), key)
        }
    }

    @Test
    fun aSignInThatCannotRecordWhoTheGatewayNamedKeepsNothingAndTheSessionSaysSoOnceOnItsErrors() = runBlocking {
        Realm().use { realm ->
            realm.answersFresh()
            realm.script("/api/users/me", Said(200, alice))
            val storage = MemoryStorage()
            // A sign-in whose person no gateway has named yet, and which cannot record one.
            val access = tokenFor("access-1")
            val kept = Unrecording(MemorySignIn(HeldSignIn(access, "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, null)))
            sessionFromKept(kb(realm), kept, storage = storage).use { opened ->
                // Said as the session started, before its opener could listen: the stream's first reader hears it.
                val said = withTimeout(5_000) { opened.session.errors().use { errors -> errors.filterIsInstance<SessionError>().first() } }
                assertEquals(SessionErrorCode.KeepFailed, said.reason)
                assertEquals("local", said.kbId)
                // The session itself goes on.
                assertEquals(access, opened.session.token.value)
                assertEquals("alice@example.org", opened.session.user.value?.email)
                withTimeout(5_000) { opened.client.browse.resource(ResourceId("res-1")).first { it is CacheState.Ready } }
                delay(semiont.Timings.SAVE_DEBOUNCE_MS * 4)
            }
            assertNull(kept.held()?.personKey)
            for (key in PERSISTED_QUERIES.map { cacheKey("local", ALICE_KEY, it.query.wire) } + lastEventIdKey("local", ALICE_KEY)) assertNull(storage.get(key), key)
        }
    }

    @Test
    fun aFailureTheClosingSaveMeetsIsSaidOnTheSessionsErrorsBeforeTheyEnd() = runBlocking {
        Realm().use { realm ->
            realm.answersFresh()
            realm.script("/api/users/me", Said(200, alice))
            val storage = MemoryStorage()
            val kept = Unreadable(MemorySignIn(HeldSignIn(tokenFor("access-1"), "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, ALICE_KEY)))
            val opened = sessionFromKept(kb(realm), kept, storage = storage)
            val errors = opened.session.errors()
            opened.use {
                // From here the sign-in cannot be read. What res-1's answer owes is written after a pause, and nothing here
                // waits, so the close owes it as a rule; whichever save makes it, the closing one or the debounced one, cannot read the sign-in.
                kept.unreadable = true
                withTimeout(5_000) { opened.client.browse.resource(ResourceId("res-1")).first { it is CacheState.Ready } }
            }
            // The stream ends, and it said what the closing save met before it did, once.
            val said = withTimeout(5_000) { errors.toList() }
            assertEquals(listOf(SessionErrorCode.KeepFailed), said.filterIsInstance<SessionError>().map { it.reason })
            assertEquals(1, kept.refused.get())
            assertNull(storage.get(KEPT_FOR_ALICE.first))
        }
    }

    @Test
    fun aFailureAClosingSaveMeetsOnceTheSignInsReadingHasWaitedIsSaidOnTheSessionsErrorsBeforeTheyEnd() = runBlocking {
        Realm().use { realm ->
            realm.answersFresh()
            realm.script("/api/users/me", Said(200, alice))
            val storage = MemoryStorage()
            val unreadable = Unreadable(MemorySignIn(HeldSignIn(tokenFor("access-1"), "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, ALICE_KEY)))
            val kept = Waiting(unreadable)
            val opened = sessionFromKept(kb(realm), kept, storage = storage)
            val errors = opened.session.errors()
            val gate = CompletableDeferred<Unit>()
            opened.use {
                // From here the sign-in's reading waits, and then fails: the save res-1's answer owes waits for it, past the close.
                unreadable.unreadable = true
                kept.gate = gate
                withTimeout(5_000) { opened.client.browse.resource(ResourceId("res-1")).first { it is CacheState.Ready } }
            }
            withTimeout(5_000) {
                while (kept.waited.get() == 0) delay(5)
            }
            kept.gate = null
            gate.complete(Unit)
            // The stream ends only once that save has been made, and it said what the save met before it did, once.
            val said = withTimeout(5_000) { errors.toList() }
            assertEquals(listOf(SessionErrorCode.KeepFailed), said.filterIsInstance<SessionError>().map { it.reason })
            assertEquals(1, unreadable.refused.get())
            assertNull(storage.get(KEPT_FOR_ALICE.first))
        }
    }

    @Test
    fun aSignInThatCannotBeReadAsTheSessionStartsFailsItsOpeningWithWhatTheReadingThrew() {
        Realm().use { realm ->
            for (storage in listOf(null, MemoryStorage())) {
                val kept = Unreadable(MemorySignIn(HeldSignIn(tokenFor("access-1"), "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, ALICE_KEY)))
                kept.unreadable = true
                val failure = assertThrows(IOException::class.java) { runBlocking { sessionFromKept(kb(realm), kept, storage = storage) } }
                assertEquals("the sign-in cannot be read", failure.message)
            }
            assertEquals(emptyList<Asked>(), realm.of("/api/users/me"))
        }
    }

    @Test
    fun aSignInThatCannotBeReadAsTheStartRenewsItIsARenewalWithNoAnswer() = runBlocking {
        Realm().use { realm ->
            val beneath = MemorySignIn(HeldSignIn(tokenFor("access-1", -3600), "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, null))
            // Read as the session starts, and not when its start renews the kept token, which has expired.
            val kept = ReadableFor(1, beneath)
            val ended = CopyOnWriteArrayList<SessionEndReason>()
            sessionFromKept(kb(realm), kept, onAuthFailed = { ended += it }).use { opened ->
                // Said as the session started, before its opener could listen: the stream's first reader hears it.
                val said = withTimeout(5_000) { opened.session.errors().use { errors -> errors.filterIsInstance<SessionError>().first() } }
                assertEquals(SessionErrorCode.AuthFailed, said.reason)
                assertNull(opened.session.token.value)
                // The session is not over, and nobody was asked: there was nothing read to renew with.
                assertEquals(emptyList<SessionEndReason>(), ended)
                assertEquals(emptyList<Asked>(), realm.of("/token"))
                assertEquals(emptyList<Asked>(), realm.of("/api/users/me"))
                assertNotNull(beneath.held())
            }
        }
    }

    @Test
    fun aSignInThatCannotBeReadAsARefusedTokenIsRenewedIsARenewalWithNoAnswer() = runBlocking {
        Realm().use { realm ->
            realm.script("/api/users/me", Said(200, alice))
            val kept = Unreadable(MemorySignIn(HeldSignIn(tokenFor("access-1"), "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, null)))
            val ended = CopyOnWriteArrayList<SessionEndReason>()
            sessionFromKept(kb(realm), kept, onAuthFailed = { ended += it }).use { opened ->
                val session = opened.session
                session.errors().use { errors ->
                    kept.unreadable = true
                    // The gateway refused the token the session holds, and the renewal cannot read what to renew with.
                    assertNull(session.refresh(session.token.value))
                    val said = withTimeout(5_000) { errors.filterIsInstance<SessionError>().first() }
                    assertEquals(SessionErrorCode.RefreshExhausted, said.reason)
                }
                // No usable token, what is kept stays, and the session is not over.
                assertNull(session.token.value)
                assertEquals(emptyList<SessionEndReason>(), ended)
                assertEquals(emptyList<Asked>(), realm.of("/token"))
                kept.unreadable = false
                assertNotNull(kept.held())
            }
        }
    }

    @Test
    fun aSessionThatNeverAsksWhoItsTokenIsShowsWhatWasKeptForThePersonItsSignInNames() = runBlocking {
        Realm().use { realm ->
            val storage = MemoryStorage()
            storage.set(KEPT_FOR_ALICE.first, KEPT_FOR_ALICE.second)
            val kept = MemorySignIn(HeldSignIn(tokenFor("access-1"), "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, ALICE_KEY))
            sessionFromKept(kb(realm), kept, validate = false, storage = storage).use { opened ->
                val shown = withTimeout(5_000) { opened.client.browse.resource(ResourceId("res-1")).first() }
                assertEquals("kept", (shown as? CacheState.Ready)?.value?.name, "$shown")
            }
            assertEquals(emptyList<Asked>(), realm.of("/api/users/me"))
        }
    }

    @Test
    fun aSessionThatNeverAsksWhoItsTokenIsKeepsForNobodyWhenItsSignInNamesNobodyYet() = runBlocking {
        Realm().use { realm ->
            val storage = MemoryStorage()
            storage.set(KEPT_FOR_ALICE.first, KEPT_FOR_ALICE.second)
            val kept = MemorySignIn(HeldSignIn(tokenFor("access-1"), "refresh-1", SCRIPT_CLIENT_ID, "${realm.origin}/token", null, null))
            sessionFromKept(kb(realm), kept, validate = false, storage = storage).use { opened ->
                assertEquals(CacheState.Pending, withTimeout(5_000) { opened.client.browse.resource(ResourceId("res-1")).first() })
            }
            assertEquals(emptyList<Asked>(), realm.of("/api/users/me"))
            assertNull(kept.held()?.personKey)
        }
    }

    @Test
    fun withNothingKeptTheSessionIsSignedOut() = runBlocking {
        Realm().use { realm ->
            sessionFromKept(kb(realm), MemorySignIn()).use { opened ->
                assertNull(opened.session.token.value)
                assertEquals(emptyList<Asked>(), realm.of("/api/users/me"))
            }
        }
    }

    @Test
    fun forJavaASessionFromKeptIsOpenedWithNoCallbackForWhatWentWrong() {
        Realm().use { realm ->
            // What went wrong is read from the session's errors: the entry point for Java takes no callback for it either.
            sessionFromKeptFuture(kb(realm), MemorySignIn(), true, null, null).get(10, TimeUnit.SECONDS).use { opened ->
                assertNull(opened.session.token.value)
                assertEquals(emptyList<Asked>(), realm.of("/api/users/me"))
            }
        }
    }

    @Test
    fun aKnowledgeBaseReachedOtherwiseThanOverHttpHasNoSessionOverIt() {
        val local = KbTarget(id = "here", label = "Here", endpoint = LocalEndpoint(kbId = "here"))
        val refusal = assertThrows(SessionError::class.java) { runBlocking { sessionFromKept(local, MemorySignIn()) } }
        assertEquals(SessionErrorCode.ConstructFailed, refusal.reason)
    }
}
