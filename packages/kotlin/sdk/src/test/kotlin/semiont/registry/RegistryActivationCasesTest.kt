package semiont.registry

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import semiont.Spec
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode
import semiont.errors.SemiontError
import semiont.errors.SessionError
import semiont.errors.SessionErrorCode
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.http.Realm
import semiont.session.OpenedSession
import semiont.storage.MemoryStorage
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private val activation = Spec.read("session/registry-activation-cases.json").jsonObject
private val factoryFailure = Spec.read("session/registry-factory-failure-cases.json").jsonObject

/** What a table holds beside its rows: what it says of itself, and who runs it. */
private val NOT_ROWS = setOf("\$comment", "runBy", "notYetReached", "absent")

private fun JsonObject.text(name: String): String = getValue(name).jsonPrimitive.content

private fun JsonObject.texts(name: String): List<String> = getValue(name).jsonArray.map { it.jsonPrimitive.content }

private fun askedFor(kbId: String): String = "asked for $kbId"

/** One of the session's own errors, by its code, with its message, as a row states it, of the knowledge base `kbId`. */
private fun ownOf(stated: JsonObject, kbId: String): SessionError =
    SessionError(SessionErrorCode.entries.single { it.code == stated.text("own") }, stated.text("message"), kbId)

/** What a row says the registry said on its errors: each by its code and its message. */
private fun saidOf(row: JsonObject): List<Pair<String, String>> =
    row.getValue("registryErrors").jsonArray.map { it.jsonObject }.map { it.text("code") to it.text("message") }

/** A factory over `factory` that puts each knowledge base it is asked for a session of in `steps`, in order, before it asks `factory`. */
private class Counting(private val factory: SessionFactory, private val steps: MutableList<String>) : SessionFactory by factory {
    override suspend fun session(options: SessionFactoryOptions): OpenedSession {
        steps += askedFor(options.kb.id)
        return factory.session(options)
    }
}

/** A factory over `factory` that refuses the session of the knowledge base `kbId` with `refusal`, and builds every other as `factory` does. */
private class Refusing(private val factory: SessionFactory, private val kbId: String, private val refusal: SemiontError) : SessionFactory by factory {
    override suspend fun session(options: SessionFactoryOptions): OpenedSession =
        if (options.kb.id == kbId) throw refusal else factory.session(options)
}

/** Activate kb-b, begun at once in the caller's thread: what the activation was refused with, or null when it was not. */
private fun activateB(browser: SemiontBrowser): Deferred<Throwable?> =
    CoroutineScope(Dispatchers.Unconfined).async { runCatching { browser.setActiveKb(KB_B) }.exceptionOrNull() }

/** That `refusal` is a refusal at the call with `bus.closed`. */
private fun refusedAsClosed(why: String, refusal: Throwable?) {
    assertEquals(BusRequestErrorCode.Closed, (refusal as? BusRequestError)?.reason, "$why: the activation was refused with $refusal")
}

/**
 * No session being active, a registry activates a registered knowledge base
 * with a kept sign-in, over a factory that refuses its session with
 * `refusal`. Once the activation has returned, its factory was asked for one
 * session, no session is active, and the storage's active key names that
 * knowledge base. Gives what the registry said on its errors, each by its code
 * and its message.
 */
private suspend fun refusedWith(refusal: SemiontError): List<Pair<String, String>> {
    val steps = CopyOnWriteArrayList<String>()
    val world = World().with(kbOfA())
    return SemiontBrowser(SemiontBrowserConfig(world.storage, Counting(Refusing(world.factory.sessions, KB_A, refusal), steps))).use { browser ->
        val errors = browser.errors()
        // The registry activates the knowledge base stored as active as it is made: that activation is the row's.
        eventually("the registry asked for a session") { steps.isNotEmpty() }
        eventually("the activation returned") { !browser.sessionActivating.value }
        assertEquals(listOf(askedFor(KB_A)), steps.toList())
        assertNull(browser.activeSession.value)
        assertEquals(KB_A, world.storage.get(ACTIVE_KEY))
        browser.close()
        soon { errors.toList() }.map { it.code to it.message }
    }
}

/**
 * kb-a's session is active, and kb-b is activated once the registry's close
 * has returned, kb-a's client owing nothing; or while its close waits for
 * kb-a's client to write the save it owes, to a storage that holds that write
 * open: from within that write, and from the test while it is held. Each
 * activation is refused at the call with `bus.closed`; the factory was asked
 * for nothing more; nothing was said on the registry's errors; the storage's
 * active key still names kb-a; and a second close does nothing.
 */
private fun closedCase(row: JsonObject): Unit = runBlocking {
    val why = row.text("why")
    val closing = when (val phase = row.text("while")) {
        "closed" -> false
        "closing" -> true
        else -> throw AssertionError("$why: activates while $phase, which no runner runs")
    }
    Realm().use { realm ->
        val steps = CopyOnWriteArrayList<String>()
        val refusals = CopyOnWriteArrayList<Deferred<Throwable?>>()
        val storage = registeredAt(realm)
        val caches = SteppedCaches(steps, MemoryStorage())
        SemiontBrowser(SemiontBrowserConfig(storage, Counting(KeepingSessions(keptNamingAlice(realm), caches), steps))).use { browser ->
            val errors = browser.errors()
            val session = live(browser)
            if (closing) {
                owingItsSave(session)
                val holding = CompletableDeferred<Unit>()
                val letGo = CountDownLatch(1)
                // The owed save is written, and held open until the test lets it go: kb-b is activated from within it.
                caches.within = {
                    refusals += activateB(browser)
                    holding.complete(Unit)
                    check(letGo.await(10, TimeUnit.SECONDS)) { "$why: the owed save was never let go" }
                }
                // The close is made where nothing waits on it: the write it makes holds its thread.
                val closed = async(Dispatchers.IO) { browser.close() }
                soon { holding.await() }
                refusals += activateB(browser)
                letGo.countDown()
                soon { closed.await() }
            } else {
                eventually("$why: the client owes nothing") { session.client.persistenceSettled }
                browser.close()
                refusals += activateB(browser)
            }

            assertEquals(if (closing) 2 else 1, refusals.size, "$why: the activations begun")
            for (refusal in refusals) refusedAsClosed(why, soon { refusal.await() })
            val asked = if (closing) listOf(askedFor(KB_A), WROTE_THE_OWED_SAVE) else listOf(askedFor(KB_A))
            assertEquals(asked, steps.toList(), "$why: what the factory and the storage were asked, in order")
            assertEquals(emptyList<String>(), soon { errors.toList() }.map { it.code }, "$why: said on the registry's errors")
            assertEquals(KB_A, storage.get(ACTIVE_KEY), "$why: the storage's active key")

            // A second close does nothing.
            browser.close()
            assertEquals(asked, steps.toList(), "$why: what was asked after a second close")
        }
    }
}

/** The refusal of a switching row's next session, of kb-b; null when it is built. */
private fun refusalOfNext(next: JsonElement): SessionError? = when {
    next is JsonPrimitive && next.isString && next.content == "built" -> null
    next is JsonObject && "own" in next -> ownOf(next, KB_B)
    else -> throw AssertionError("a next session that is $next, which no runner runs")
}

/**
 * kb-a's session is active, its client owing a save, still waiting out its
 * debounce, to a storage that writes it or refuses every write of that
 * client, and kb-b is activated, over a factory that builds its session or
 * refuses it. The first session ended, its owed save asked of the storage
 * once, by its closing flush, before the next was asked for; a session is
 * active or not; and the storage's active key names kb-b. What the registry
 * said on its errors, read to their end once it has closed, is the row's:
 * kb-b's session, if there is one, owes nothing as it closes.
 */
private fun switchingCase(row: JsonObject): Unit = runBlocking {
    val why = row.text("why")
    val refuses = when (val storage = row.text("storage")) {
        "writes" -> false
        "refuses" -> true
        else -> throw AssertionError("$why: a storage that $storage, which no runner runs")
    }
    val next = refusalOfNext(row.getValue("next"))
    Realm().use { realm ->
        val steps = CopyOnWriteArrayList<String>()
        val storage = registeredAt(realm)
        val caches = SteppedCaches(steps, MemoryStorage())
        val keeping = KeepingSessions(keptNamingAlice(realm), caches)
        val factory = Counting(if (next == null) keeping else Refusing(keeping, KB_B, next), steps)
        SemiontBrowser(SemiontBrowserConfig(storage, factory)).use { browser ->
            val errors = browser.errors()
            owingItsSave(live(browser))
            caches.refuses = refuses
            browser.setActiveKb(KB_B)

            assertEquals(listOf(askedFor(KB_A), WROTE_THE_OWED_SAVE, askedFor(KB_B)), steps.toList(), "$why: what the factory and the storage were asked, in order")
            assertEquals(row.getValue("active").jsonPrimitive.boolean, browser.activeSession.value != null, "$why: a session is active")
            assertEquals(KB_B, storage.get(ACTIVE_KEY), "$why: the storage's active key")
            browser.close()
            assertEquals(row.texts("registryErrors"), soon { errors.toList() }.map { it.code }, "$why: said on the registry's errors")
        }
    }
}

/** The rows of each section of `table`, each run by the runner of its section; a section no runner runs fails here. */
private fun rowsOf(table: JsonObject, path: String, runnerOf: (String) -> ((JsonObject) -> Unit)?): List<DynamicTest> =
    table.filterKeys { it !in NOT_ROWS }.flatMap { (section, rows) ->
        val run = runnerOf(section) ?: throw AssertionError("$path has a section no runner runs: $section")
        rows.jsonArray.map { it.jsonObject }.map { row -> DynamicTest.dynamicTest("$section: ${row.text("why")}") { run(row) } }
    }

/**
 * How a registry activates a knowledge base: when its factory refuses the
 * session, once its close has begun, and when another knowledge base's
 * session is active (protocol/specs/src/session/registry-activation-cases.json);
 * and what it says when its factory fails with something that is not one of
 * the session's own errors (protocol/specs/src/session/registry-factory-failure-cases.json).
 * Each row runs a registry over a storage in which each of its knowledge bases
 * is registered, so it activates the one stored as active as it is made, and
 * over a factory that records each knowledge base it is asked for a session
 * of, in order, and then refuses as the row says or builds the session. A
 * refused row's sessions are scripted, each over a sign-in kept. A closed or
 * switching row's are sessions over HTTP at one gateway, over a sign-in that
 * names Alice, whose clients keep what they hold in a storage of their own: a
 * fresh read of a resource leaves kb-a's client owing its save, still waiting
 * out its debounce, and that storage records each ask to write it in the list
 * the factory records its asks in.
 */
class RegistryActivationCasesTest {
    @TestFactory
    fun aRegistryActivatesAsTheTableSays(): List<DynamicTest> = rowsOf(activation, "session/registry-activation-cases.json") { section ->
        when (section) {
            "refused" -> { row: JsonObject ->
                runBlocking { assertEquals(saidOf(row), refusedWith(ownOf(row.getValue("refusal").jsonObject, KB_A)), row.text("why")) }
            }
            "closed" -> ::closedCase
            "switching" -> ::switchingCase
            else -> null
        }
    }

    @TestFactory
    fun aFactoryThatFailsOtherwiseIsSaidAsTheTableSays(): List<DynamicTest> = rowsOf(factoryFailure, "session/registry-factory-failure-cases.json") { section ->
        when (section) {
            "cases" -> { row: JsonObject ->
                val failure = row.getValue("failure").jsonObject
                val transport = TransportError(TransportErrorCode.entries.single { it.code == failure.text("transport") }, failure.text("message"))
                runBlocking { assertEquals(saidOf(row), refusedWith(transport), row.text("why")) }
            }
            else -> null
        }
    }
}
