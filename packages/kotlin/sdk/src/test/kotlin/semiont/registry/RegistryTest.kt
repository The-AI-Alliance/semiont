package semiont.registry

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import semiont.errors.SessionError
import semiont.http.tokenFor
import semiont.types.KbRead
import semiont.types.KnowledgeBase
import semiont.types.NewKnowledgeBase
import java.util.Collections

/**
 * The registry of knowledge bases an application holds: the list, the active
 * one and its session, and how activations take turns. Sessions are built by
 * `ScriptedSessions`, each over a scripted transport; the storage is a
 * `SharedStorage`, so a second context can write it as another window would.
 */
class RegistryTest {
    // The knowledge bases.

    @Test
    fun aKnowledgeBaseThatIsAddedIsKeptSignedInAndMadeActive() = runBlocking {
        val world = World()
        val read = KbRead("2027-01-15T08:00:00.000Z", "main")
        val added = world.browser().use { browser ->
            assertEquals(emptyList<KnowledgeBase>(), browser.kbs.value)
            assertNull(browser.activeKbId.value)
            val added = browser.addKb(NewKnowledgeBase("KB A", endpoint("localhost", 4000), DID_A, read), tokens("r"))
            assertEquals(listOf(added), browser.kbs.value)
            assertEquals(added.id, browser.activeKbId.value)
            assertEquals(added.id, sessionOf(browser))
            assertEquals(added.id, world.storage.get(ACTIVE_KEY))
            assertNotNull(storedSession(world.storage, added.id))
            added
        }
        // Its identity and what it last said survive a new registry on the storage.
        world.browser().use { reopened ->
            assertEquals(listOf(added), reopened.kbs.value)
            assertEquals(DID_A to read, reopened.kbs.value[0].did to reopened.kbs.value[0].lastRead)
            assertEquals(added.id, live(reopened).kb.id)
        }
    }

    @Test
    fun anEntryThatIsNotAKnowledgeBaseWithADidIsDroppedFromTheStorageToo() = runBlocking {
        val world = World()
        world.storage.set(
            KNOWLEDGE_BASES_KEY,
            """[
                {"id":"old","label":"No did","endpoint":{"kind":"http","host":"localhost","port":4000,"protocol":"http"}},
                {"id":"kb-a","label":"KB A","did":"did:web:example.org:kb-a","email":"someone@example.org",
                 "endpoint":{"kind":"http","host":"localhost","port":4000,"protocol":"http"}},
                "not an entry"
            ]""",
        )
        world.storage.set(ACTIVE_KEY, "old")
        world.browser().use { browser ->
            assertEquals(listOf(kbOfA()), browser.kbs.value)
            // The active one was the one dropped: the first that is left takes over.
            assertEquals(KB_A, browser.activeKbId.value)
            // What is written back is what was read, and nothing else an entry carried.
            assertEquals(listOf(kbOfA()), loadKnowledgeBases(world.storage))
            assertFalse(checkNotNull(world.storage.get(KNOWLEDGE_BASES_KEY)).contains("email"))
        }
    }

    @Test
    fun removingAKnowledgeBaseForgetsItAndTheNextOneTakesOver() = runBlocking {
        val world = World().with(kbOfA(), kbOfB())
        world.browser().use { browser ->
            live(browser)
            browser.addOpenResource(semiont.identifiers.ResourceId("res-1"), "One")
            browser.setLastViewedResource(semiont.identifiers.ResourceId("res-1"))
            assertEquals(listOf("res-1"), world.storedOpen(KB_A))

            browser.removeKb(KB_A)
            assertEquals(listOf(kbOfB()), browser.kbs.value)
            assertEquals(KB_B, sessionOf(browser))
            assertNull(storedSession(world.storage, KB_A))
            assertEquals(emptyList<String>(), world.storedOpen(KB_A))
            assertFalse(KB_A in world.storedLastViewed())
            assertTrue(world.factory.sessions.transports(KB_A)[0].closed)

            browser.removeKb(KB_B)
            assertEquals(emptyList<KnowledgeBase>(), browser.kbs.value)
            assertNull(browser.activeKbId.value)
            assertNull(sessionOf(browser))
            assertNull(world.storage.get(ACTIVE_KEY))
        }
    }

    @Test
    fun anEntryTakesWhatItsKnowledgeBaseLastSaidAndKeepsItsDid() = runBlocking {
        val world = World().with(kbOfA(), kbOfB())
        world.browser().use { browser ->
            browser.updateKb(KB_B, "Renamed", KbRead("2026-10-15T08:00:00.000Z"))
            val kbs = browser.kbs.value
            assertEquals(kbOfA(), kbs[0])
            assertEquals("Renamed" to DID_B, kbs[1].label to kbs[1].did)
            assertNull(checkNotNull(kbs[1].lastRead).gitBranch)
            assertEquals(kbs, loadKnowledgeBases(world.storage))
        }
    }

    @Test
    fun aStoredCredentialSaysWhetherItIsGoodExpiredOrNotThere() = runBlocking {
        val world = World().with(kbOfA(), kbOfB())
        storeSession(world.storage, KB_B, tokens("r", tokenFor("expired", -10)))
        world.browser().use { browser ->
            assertEquals(KbSessionStatus.Authenticated, browser.kbSessionStatus(KB_A))
            assertEquals(KbSessionStatus.Expired, browser.kbSessionStatus(KB_B))
            assertEquals(KbSessionStatus.SignedOut, browser.kbSessionStatus("another"))
        }
    }

    @Test
    fun theIdentityTokenIsWhatItWasLastSetTo() {
        World().browser().use { browser ->
            assertNull(browser.identityToken.value)
            browser.setIdentityToken("an-identity-token")
            assertEquals("an-identity-token", browser.identityToken.value)
            browser.setIdentityToken(null)
            assertNull(browser.identityToken.value)
        }
    }

    // The active session.

    @Test
    fun makingAnotherKnowledgeBaseActiveShowsNoSessionAndThenTheNewOne() = runBlocking {
        val world = World().with(kbOfA(), kbOfB())
        world.browser().use { browser ->
            live(browser)
            world.factory.sessions.answersAfter(300)
            val seen = Collections.synchronizedList(mutableListOf<String?>())
            val watching = launch(Dispatchers.Unconfined) { browser.activeSession.collect { seen += it?.kb?.id } }

            browser.setActiveKb(KB_B)
            settle()
            watching.cancel()

            assertEquals(listOf(KB_A, null, KB_B), seen.toList())
            assertEquals(KB_B, world.storage.get(ACTIVE_KEY))
            // The session it replaced is closed, and its client with it.
            assertTrue(world.factory.sessions.transports(KB_A)[0].closed)
            assertFalse(world.factory.sessions.transports(KB_B)[0].closed)
        }
    }

    @Test
    fun makingNoneActiveClosesTheSessionAndLeavesNone() = runBlocking {
        val world = World().with(kbOfA())
        world.browser().use { browser ->
            live(browser)
            browser.setActiveKb(null)
            assertNull(sessionOf(browser))
            assertNull(browser.activeKbId.value)
            assertNull(browser.activeSignals.value)
            assertFalse(browser.sessionActivating.value)
            assertTrue(world.factory.sessions.transports(KB_A)[0].closed)
            assertNull(world.storage.get(ACTIVE_KEY))
        }
    }

    @Test
    fun makingTheActiveOneActiveAgainChangesNothing() = runBlocking {
        val world = World().with(kbOfA())
        world.browser().use { browser ->
            val session = live(browser)
            browser.setActiveKb(KB_A)
            assertEquals(session.id, live(browser).id)
            assertEquals(1, world.factory.sessions.transports(KB_A).size)
        }
    }

    @Test
    fun ofTwoActivationsAskedForTogetherTheLastOneAskedForStands() = runBlocking {
        val world = World().with(kbOfA(), kbOfB())
        world.browser().use { browser ->
            live(browser)
            // Asked one after another, without waiting for any: what stands is the last one asked for.
            val asked = listOf(KB_B, KB_A, KB_B).map { kbId ->
                async(Dispatchers.Default) { browser.setActiveKb(kbId) }.also { delay(5) }
            }
            soon { asked.awaitAll() }
            assertEquals(KB_B, sessionOf(browser))
            assertEquals(KB_B, browser.activeKbId.value)
            assertFalse(browser.sessionActivating.value)
            // Every session but the one that stands is closed.
            val running = listOf(KB_A, KB_B).flatMap { world.factory.sessions.transports(it) }.filter { !it.closed }
            assertEquals(1, running.size)
        }
    }

    @Test
    fun anActivationOvertakenWhileItWaitedItsTurnBuildsNoSession() = runBlocking {
        val world = World().with(kbOfA(), kbOfB())
        world.browser().use { browser ->
            live(browser)
            // The first activation holds the turn while its session comes up, and the other two are asked for behind it.
            world.factory.sessions.answersAfter(500)
            val asked = mutableListOf(async(Dispatchers.Default) { browser.setActiveKb(KB_B) })
            // B's session is being built: the first activation has closed A's and holds the turn.
            eventually("B's session is being built") { world.factory.sessions.transports(KB_B).isNotEmpty() }
            for (kbId in listOf(KB_A, KB_B)) {
                asked += async(Dispatchers.Default) { browser.setActiveKb(kbId) }
                delay(5)
            }
            soon { asked.awaitAll() }
            assertEquals(KB_B, sessionOf(browser))
            // A had the session it started with, and no other was built for it.
            assertEquals(1, world.factory.sessions.transports(KB_A).size)
        }
    }

    @Test
    fun aSessionThatComesUpAfterItsKnowledgeBaseStoppedBeingActiveIsNeverShown() = runBlocking {
        val world = World().with(kbOfA(), kbOfB())
        world.browser().use { browser ->
            live(browser)
            world.factory.sessions.answersAfter(500)
            // Every session shown after the first: the knowledge base that was active then, and the session's own.
            val seen = Collections.synchronizedList(mutableListOf<Pair<String?, String>>())
            val watching = launch(Dispatchers.Unconfined) {
                browser.activeSession.drop(1).collect { session -> if (session != null) seen += browser.activeKbId.value to session.kb.id }
            }
            val toB = async(Dispatchers.Default) { browser.setActiveKb(KB_B) }
            // B's session is still coming up when A is asked for again.
            eventually("B's session is being built") { world.factory.sessions.transports(KB_B).isNotEmpty() }
            val toA = async(Dispatchers.Default) { browser.setActiveKb(KB_A) }
            soon { listOf(toB, toA).awaitAll() }
            settle()
            watching.cancel()
            assertEquals(listOf(KB_A to KB_A), seen.toList())
            // The session that came up too late was closed, and not left running.
            assertTrue(world.factory.sessions.transports(KB_B)[0].closed)
        }
    }

    @Test
    fun aSessionBeingBroughtUpIsSaidToBeOnItsWay() = runBlocking {
        val world = World().with(kbOfA())
        // A session that takes a moment to come up: one that is up at once is up before anyone could be told it was coming.
        world.factory.sessions.answersAfter(500)
        world.browser().use { browser ->
            eventually("an activation is under way") { browser.sessionActivating.value }
            assertNull(sessionOf(browser))
            live(browser)
            assertFalse(browser.sessionActivating.value)
        }
    }

    @Test
    fun aSessionThatCannotBeBuiltIsSaidAndThereIsNone() = runBlocking {
        val world = World().with(kbOfA())
        world.factory.sessions.refuseToBuild("this factory builds nothing")
        world.browser().use { browser ->
            // Heard from before the registry begins its first activation.
            val refused = soon { firstOf(browser.errors()) }
            settle()
            assertEquals("session.construct-failed" to KB_A, refused.code to refused.kbId)
            assertNull(sessionOf(browser))
            assertNull(browser.activeSignals.value)
            assertFalse(browser.sessionActivating.value)
        }
    }

    @Test
    fun whatAHostShowsAboutASessionIsThereExactlyWhenTheSessionIs() = runBlocking {
        val world = World().with(kbOfA())
        world.browser().use { browser ->
            assertNull(browser.activeSignals.value)
            live(browser)
            val first = checkNotNull(browser.activeSignals.value)
            assertNull(first.sessionEnded.value)

            // A sign-in on the active knowledge base replaces both together.
            browser.signIn(KB_A, tokens("r2"))
            live(browser)
            val second = checkNotNull(browser.activeSignals.value)
            assertNotSame(first, second)
            assertTrue(ended(first.sessionEnded))

            browser.signOut(KB_A)
            assertNull(browser.activeSignals.value)
            assertNull(sessionOf(browser))
        }
    }
}

/** The first of what `events` gives, and then no more of them. */
internal suspend fun firstOf(events: semiont.transport.Events<SessionError>): SessionError = events.use { it.first() }
