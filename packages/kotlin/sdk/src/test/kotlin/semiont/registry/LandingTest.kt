package semiont.registry

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import semiont.types.HttpEndpoint
import semiont.types.KbDescription
import semiont.types.KbRead
import semiont.types.KnowledgeBase
import semiont.types.wireJson
import java.util.Collections

private fun signedIn(at: HttpEndpoint, said: JsonObject, refresh: String, kbId: String? = null, expectedDid: String? = null, expectedName: String? = null) =
    SignedIn(at, wireJson.decodeFromJsonElement(KbDescription.serializer(), said), tokens(refresh), kbId, expectedDid, expectedName)

/** A sign-in landing on the registry: new tokens for an entry, a sign-in landing on the entry for the knowledge base that answered, and signing out. */
class LandingTest {
    @Test
    fun newTokensForTheActiveKnowledgeBaseReplaceItsSession() = runBlocking {
        val world = World().with(kbOfA())
        world.browser().use { browser ->
            val first = live(browser)
            browser.signIn(KB_A, tokens("renewed"))
            val second = live(browser)
            assertNotEquals(first.id, second.id)
            assertTrue(world.factory.sessions.transports(KB_A)[0].closed)
            assertEquals("renewed", world.storedRefresh(KB_A))
        }
    }

    @Test
    fun aSignInAtANewAddressRegistersTheKnowledgeBaseUnderWhatItSaysItIs() = runBlocking {
        val world = World()
        world.browser().use { browser ->
            val outcome = browser.signedIn(signedIn(endpoint("localhost", 4000), description("KB A", "example.org:kb-a", "main"), "r"))
            assertNull(outcome.expected)
            assertEquals(DID_A to "KB A", outcome.kb.did to outcome.kb.label)
            assertEquals("main", checkNotNull(outcome.kb.lastRead).gitBranch)
            assertEquals(listOf(outcome.kb), browser.kbs.value)
            assertEquals(outcome.kb.id, sessionOf(browser))
            assertEquals("r", world.storedRefresh(outcome.kb.id))
        }
    }

    @Test
    fun aSignInReportsWhatThePersonBelievedTheyClicked() = runBlocking {
        World().browser().use { browser ->
            val outcome = browser.signedIn(signedIn(endpoint("localhost", 4000), description("KB A", "example.org:kb-a"), "r", expectedDid = DID_B, expectedName = "KB B"))
            // The knowledge base that answered is the one registered. What was believed is said back, for a host to set against it.
            assertEquals(DID_A, outcome.kb.did)
            assertEquals(Expected(DID_B, "KB B"), outcome.expected)
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = [true, false])
    fun aSignInToARegisteredKnowledgeBaseTakesWhatItAndTheIssuerNowSay(byId: Boolean) = runBlocking {
        val world = World().with(kbOfA())
        world.browser().use { browser ->
            val first = live(browser)
            val outcome = browser.signedIn(
                signedIn(endpoint("localhost", 4000), description("KB A, renamed", "example.org:kb-a", "feature"), "r2", kbId = if (byId) KB_A else null),
            )
            // The same entry, under the name it gives itself now.
            assertEquals(KB_A to "KB A, renamed", outcome.kb.id to outcome.kb.label)
            assertEquals(listOf(outcome.kb), browser.kbs.value)
            // What was believed is the entry as it was, under the label it had.
            assertEquals(Expected(DID_A, "KB A"), outcome.expected)
            assertEquals("r2", world.storedRefresh(KB_A))
            assertNotEquals(first.id, live(browser).id)
        }
    }

    @Test
    fun aSignInADifferentKnowledgeBaseAnswersLeavesTheEntryAndLandsOnANewOne() = runBlocking {
        val believed = kb(KB_A, "KB A", DID_A, endpoint("localhost", 4000), KbRead("2027-01-15T08:00:00.000Z", "main"))
        val world = World().with(believed)
        val before = storedSession(world.storage, KB_A)
        world.browser().use { browser ->
            live(browser)
            val outcome = browser.signedIn(signedIn(endpoint("localhost", 4000), description("KB B", "example.org:kb-b", "other"), "for-b", kbId = KB_A))
            // The entry the person believed they were signing in to is as it was: its did, its name, what it last said, and its credentials.
            val kbs = browser.kbs.value
            assertEquals(believed, kbs[0])
            assertEquals(before, storedSession(world.storage, KB_A))
            // The knowledge base that answered has an entry of its own, at the same address, and it is the one signed in and active.
            assertEquals(2, kbs.size)
            assertEquals(outcome.kb, kbs[1])
            assertEquals(DID_B to "KB B", outcome.kb.did to outcome.kb.label)
            assertNotEquals(KB_A, outcome.kb.id)
            assertEquals(believed.endpoint, outcome.kb.endpoint)
            assertEquals(outcome.kb.id, sessionOf(browser))
            assertEquals("for-b", world.storedRefresh(outcome.kb.id))
            assertEquals(Expected(DID_A, "KB A"), outcome.expected)
        }
    }

    @Test
    fun ofTwoEntriesAtOneAddressASignInLandsOnTheOneWhoseDidAnswered() = runBlocking {
        val twin = kb("kb-a2", "KB B here", DID_B, endpoint("localhost", 4000))
        val world = World().with(kbOfA(), twin)
        world.browser().use { browser ->
            live(browser)
            val outcome = browser.signedIn(signedIn(endpoint("localhost", 4000), description("KB B", "example.org:kb-b"), "for-b"))
            val kbs = browser.kbs.value
            assertEquals(twin.id, outcome.kb.id)
            assertEquals(2, kbs.size)
            assertEquals(kbOfA(), kbs[0])
            assertEquals("kb-a2", sessionOf(browser))
            // An address with two entries singles out no belief.
            assertNull(outcome.expected)
        }
    }

    @Test
    fun anEntryAtAnotherAddressWithTheSameDidIsNotTheOneSignedIn() = runBlocking {
        // One knowledge base in two places is two entries.
        val world = World().with(kbOfA())
        world.browser().use { browser ->
            live(browser)
            val outcome = browser.signedIn(signedIn(endpoint("localhost", 4100), description("KB A", "example.org:kb-a"), "r"))
            assertNotEquals(KB_A, outcome.kb.id)
            assertEquals(DID_A, outcome.kb.did)
            assertEquals(2, browser.kbs.value.size)
            assertNull(outcome.expected)
        }
    }

    @Test
    fun signingOutForgetsTheTokensClosesTheSessionAndHasTheIssuerTold() = runBlocking {
        val world = World().with(kbOfA())
        val before = storedSession(world.storage, KB_A)
        world.browser().use { browser ->
            live(browser)
            val told = Collections.synchronizedList(mutableListOf<List<KnowledgeBase>>())
            val listening = launch(Dispatchers.Unconfined) { browser.kbs.drop(1).collect { told += it } }

            browser.signOut(KB_A)
            eventually("the issuer was told") { world.factory.sessions.revoked.isNotEmpty() }

            assertNull(storedSession(world.storage, KB_A))
            assertNull(sessionOf(browser))
            assertTrue(world.factory.sessions.transports(KB_A)[0].closed)
            assertEquals(listOf(before), world.factory.sessions.revoked.toList())
            // Still registered, and still the active one: only signed out.
            assertEquals(listOf(kbOfA()), browser.kbs.value)
            assertEquals(KB_A, browser.activeKbId.value)
            // The list is said again, so whoever shows its status reads it anew.
            assertTrue(told.isNotEmpty())
            assertEquals(KbSessionStatus.SignedOut, browser.kbSessionStatus(KB_A))

            // Signing out of what is not signed in tells the issuer nothing.
            browser.signOut(KB_A)
            settle()
            assertEquals(1, world.factory.sessions.revoked.size)
            listening.cancel()
        }
    }
}
