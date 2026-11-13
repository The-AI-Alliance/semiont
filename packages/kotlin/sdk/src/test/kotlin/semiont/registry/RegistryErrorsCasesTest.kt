package semiont.registry

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import semiont.Spec
import semiont.errors.SemiontError
import semiont.errors.SessionError
import semiont.errors.SessionErrorCode
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.http.Realm
import semiont.http.tokenFor
import semiont.session.OpenedSession
import semiont.session.PermissionDenied
import semiont.session.SemiontSession
import semiont.session.SessionSignals
import semiont.storage.MemoryStorage
import semiont.testing.FaultyTransport
import semiont.testing.TestClient
import semiont.types.KbTarget
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.random.Random

private val table = Spec.read("session/registry-errors-cases.json").jsonObject

private fun JsonObject.text(name: String): String = getValue(name).jsonPrimitive.content

private fun JsonObject.texts(name: String): List<String> = getValue(name).jsonArray.map { it.jsonPrimitive.content }

/** One thing a case's session says: one of its own errors, by its code, or a failure of its transport, by its code, with its message. */
private fun saidAs(said: JsonObject): SemiontError = when {
    "own" in said -> SessionError(SessionErrorCode.entries.single { it.code == said.text("own") }, "said by the case", KB_A)
    "transport" in said -> TransportError(TransportErrorCode.entries.single { it.code == said.text("transport") }, said.text("message"))
    else -> throw AssertionError("$said is neither the session's own error nor its transport's failure")
}

/** What a case's session says, in order. */
private class Saying(case: JsonObject) {
    private val said = case.getValue("said").jsonArray.map { saidAs(it.jsonObject) }

    /** The last of what is said: what the registry does with it is what a runner waits for. */
    val last: SemiontError = said.last()

    /** Have `session` say each, in order: its own errors on its own, its transport's failures through `transport`, each with its exact code and message. */
    fun by(session: SemiontSession, transport: FaultyTransport) {
        for (error in said) {
            if (error is SessionError) session.say(error) else transport.fail(error)
        }
    }
}

/**
 * A factory a host writes, which reads none of its sessions' errors: each
 * session a real one over a test client of its own, whose transport fails
 * only as it is told to, whose gateway says it is Alice's, and whose renewal
 * gives a token good for an hour and records the token it was handed, so a
 * case fails if the registry renews anything. A case said `opening` the
 * session says as the factory builds it, before handing it back.
 */
private class Recording(private val saying: Saying, private val opening: Boolean) : SessionFactory {
    /** The token each renewal was handed, in order. */
    val handed: MutableList<String?> = CopyOnWriteArrayList()

    /** The transport of each session it built, in order. */
    val transports: MutableList<FaultyTransport> = CopyOnWriteArrayList()

    override suspend fun session(options: SessionFactoryOptions): OpenedSession {
        val kbId = options.kb.id
        val made = TestClient()
        transports += made.transport
        val session = SemiontSession(
            KbTarget(kbId, options.kb.label, options.kb.endpoint),
            made.client,
            MutableStateFlow(null),
            keptIn(options.storage, kbId),
            { holding: String? ->
                handed += holding
                tokenFor("renewed")
            },
            { _: String -> alice() },
            options.signals::notifySessionEnded,
            Random.Default,
        )
        session.start()
        if (opening) saying.by(session, made.transport)
        return OpenedSession(session, made.transport) {}
    }

    override suspend fun revoke(stored: StoredSession): Unit = Unit
}

/**
 * Wait for what the registry does with the last of what a case's session
 * said: one of its own errors is said on the registry's errors; a refusal for
 * lack of permission is said through the session's signals. Returns what was
 * said on the registry's errors up to then.
 */
private suspend fun waitedFor(last: SemiontError, heard: List<SessionError>, signals: SessionSignals): List<SessionError> = when {
    last is SessionError -> {
        eventually("the last of what the session said is said on the registry's errors") { heard.any { it === last } }
        heard.toList().let { said -> said.take(said.indexOfFirst { it === last } + 1) }
    }
    last is TransportError && last.reason == TransportErrorCode.Forbidden -> {
        eventually("a refusal for lack of permission is said through the signals") { signals.permissionDenied.value != null }
        heard.toList()
    }
    else -> throw AssertionError("a case's last said is ${last.code}, whose effect no case says")
}

/**
 * How a registry reads the errors of each session it activates, as their one
 * reader from the first thing the session said, over a factory that reads
 * none of them (protocol/specs/src/session/registry-errors-cases.json).
 */
class RegistryErrorsCasesTest {
    /**
     * The knowledge base's session says what the case says, while its factory
     * builds it or once it is active. Once the registry has done what it does
     * with the last of it, what was said on the registry's errors up to then
     * is what the case says; the session was not renewed; and a refusal for
     * lack of permission was said through its signals, or not.
     */
    @TestFactory
    fun whatASessionSaysIsReadAsTheTableSays(): List<DynamicTest> = table.getValue("cases").jsonArray.map { it.jsonObject }.map { case ->
        DynamicTest.dynamicTest(case.text("why")) {
            runBlocking {
                val opening = when (val phase = case.text("while")) {
                    "opening" -> true
                    "active" -> false
                    else -> throw AssertionError("a case is said while $phase, which no case says")
                }
                val saying = Saying(case)
                val factory = Recording(saying, opening)
                val world = World().with(kbOfA())
                SemiontBrowser(SemiontBrowserConfig(world.storage, factory)).use { browser ->
                    // Heard from before the registry begins its first activation, each as it is said.
                    val heard = CopyOnWriteArrayList<SessionError>()
                    val errors = browser.errors()
                    launch(Dispatchers.Unconfined) { errors.collect { heard += it } }
                    val session = live(browser)
                    val signals = checkNotNull(browser.activeSignals.value)
                    if (!opening) saying.by(session, factory.transports.single())
                    val upToThen = waitedFor(saying.last, heard, signals)
                    assertEquals(case.texts("registryErrors"), upToThen.map { it.code })
                    // A renewal is made beside what reads the errors: one made wrongly is let run before it is looked for.
                    settle()
                    assertEquals(emptyList<String?>(), factory.handed.toList(), "the tokens a renewal was handed")
                    if ("permissionDenied" in case) {
                        assertEquals(PermissionDenied(case.text("permissionDenied")), signals.permissionDenied.value)
                    } else {
                        assertNull(signals.permissionDenied.value, "a refusal for lack of permission said through the signals")
                    }
                }
            }
        }
    }

    /**
     * The registry closes while its active session's client, a session over
     * HTTP whose client keeps what it holds, does or does not owe a save, still
     * waiting out its debounce, to a storage that refuses every write of that
     * client, and its errors, read to their end, hold what the case says.
     */
    @TestFactory
    fun whatARegistrysCloseReadsIsTheTables(): List<DynamicTest> = table.getValue("closing").jsonArray.map { it.jsonObject }.map { case ->
        DynamicTest.dynamicTest(case.text("why")) {
            runBlocking {
                Realm().use { realm ->
                    val caches = SteppedCaches(CopyOnWriteArrayList(), MemoryStorage())
                    SemiontBrowser(SemiontBrowserConfig(registeredAt(realm), KeepingSessions(keptNamingAlice(realm), caches))).use { browser ->
                        val errors = browser.errors()
                        val session = live(browser)
                        if (case.getValue("owed").jsonPrimitive.boolean) {
                            owingItsSave(session)
                        } else {
                            eventually("the client owes nothing") { session.client.persistenceSettled }
                        }
                        caches.refuses = true
                        browser.close()
                        assertEquals(case.texts("registryErrors"), soon { errors.toList() }.map { it.code })
                    }
                }
            }
        }
    }
}
