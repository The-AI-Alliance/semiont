package semiont.registry

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import semiont.identifiers.ResourceId
import semiont.session.KbIdentityConflict

private fun conflict(browser: SemiontBrowser): KbIdentityConflict? = browser.activeSignals.value?.kbIdentityConflict?.value

private fun tab(named: String, openedAt: Long, order: Int) = OpenResource(ResourceId(named), "name of $named", openedAt, order, "text/plain")

/** What is open in each knowledge base, and what a session's arrival checks of it: who the knowledge base is, and each open resource. */
class OpenResourcesTest {
    // What is open, as a list.

    @Test
    fun theyAreOrderedByPlaceAndThenByWhenTheyWereOpened() {
        val ordered = sortOpenResources(listOf(tab("b", 20, 1), tab("a", 30, 0), tab("d", 15, 1), tab("c", 10, 2)))
        assertEquals(listOf("a", "d", "b", "c"), ordered.map { it.id.value })
    }

    @Test
    fun onlyAResourceTheKnowledgeBaseSaysIsGoneIsDropped() {
        val checks = mapOf(
            ResourceId("gone") to TabCheck(TabVerdict.Gone),
            ResourceId("found") to TabCheck(TabVerdict.Ready, "Its name now"),
            ResourceId("unknown") to TabCheck(TabVerdict.Unknown),
        )
        val kept = applyTabChecks(listOf(tab("gone", 1, 0), tab("found", 2, 1), tab("unknown", 3, 2), tab("opened-meanwhile", 4, 3)), checks)
        assertEquals(listOf("found", "unknown", "opened-meanwhile"), kept.map { it.id.value })
        assertEquals("Its name now", kept[0].name)
        // A check that states no media type leaves the one it had.
        assertEquals("text/plain", kept[0].mediaType)
        assertEquals("name of unknown", kept[1].name)
    }

    // What is open in the active knowledge base.

    @Test
    fun resourcesAreOpenedRenamedClosedAndMovedInTheActiveKnowledgeBase() = runBlocking {
        val world = World().with(kbOfA())
        world.browser().use { browser ->
            live(browser)
            browser.addOpenResource(ResourceId("r1"), "One", "text/plain")
            browser.addOpenResource(ResourceId("r2"), "Two", storageUri = "file://two.md")
            browser.addOpenResource(ResourceId("r3"), "Three")
            assertEquals(listOf("r1", "r2", "r3"), shown(browser))

            // Opening what is open already takes what is stated of it, in place.
            browser.addOpenResource(ResourceId("r1"), "One, renamed")
            browser.updateOpenResourceName(ResourceId("r2"), "Two, renamed")
            val tabs = browser.openResources.value
            assertEquals(listOf("r1", "r2", "r3"), shown(browser))
            assertEquals("One, renamed" to "text/plain", tabs[0].name to tabs[0].mediaType)
            assertEquals("Two, renamed" to "file://two.md", tabs[1].name to tabs[1].storageUri)

            browser.reorderOpenResources(0, 2)
            assertEquals(listOf("r2", "r3", "r1"), shown(browser))
            // A place that is not in the list moves nothing.
            browser.reorderOpenResources(0, 3)
            browser.reorderOpenResources(7, 0)
            assertEquals(listOf("r2", "r3", "r1"), shown(browser))

            browser.removeOpenResource(ResourceId("r3"))
            assertEquals(listOf("r2", "r1"), shown(browser))
            assertEquals(2, world.storedOpen(KB_A).size)
        }
    }

    @Test
    fun aResourceOpenedAfterARemovalDoesNotTakeAPlaceThatIsTaken() = runBlocking {
        val world = World().with(kbOfA())
        world.browser().use { browser ->
            live(browser)
            for (each in listOf("r1", "r2", "r3")) browser.addOpenResource(ResourceId(each), each)
            browser.removeOpenResource(ResourceId("r2"))
            browser.addOpenResource(ResourceId("r4"), "r4")
            assertEquals(listOf("r1", "r3", "r4"), shown(browser))
            assertEquals(listOf(0, 2, 3), browser.openResources.value.map { it.order })
        }
    }

    @Test
    fun nothingIsOpenOrOpenedOrViewedWithoutALiveSession() = runBlocking {
        val world = World().with(kbOfA())
        world.storage.set(OPEN_RESOURCES_BY_KB_KEY, """{"kb-a":[{"id":"r1","name":"One","openedAt":1,"order":0}]}""")
        world.storage.set(LAST_VIEWED_RESOURCE_BY_KB_KEY, """{"kb-a":"r1"}""")
        world.browser().use { browser ->
            live(browser)
            assertEquals(listOf("r1"), shown(browser))
            assertEquals(ResourceId("r1"), browser.lastViewedResource.value)

            browser.signOut(KB_A)
            assertEquals(emptyList<String>(), shown(browser))
            assertNull(browser.lastViewedResource.value)
            browser.addOpenResource(ResourceId("r2"), "Two")
            browser.setLastViewedResource(ResourceId("r2"))
            browser.removeOpenResource(ResourceId("r1"))
            // Hidden, not forgotten: the storage holds what it held.
            assertEquals(listOf("r1"), world.storedOpen(KB_A))
            assertEquals(mapOf(KB_A to "r1"), world.storedLastViewed())

            browser.signIn(KB_A, tokens("r"))
            live(browser)
            assertEquals(listOf("r1"), shown(browser))
            assertEquals(ResourceId("r1"), browser.lastViewedResource.value)
        }
    }

    @Test
    fun eachKnowledgeBaseKeepsWhatIsOpenInItAndWhereThePersonWas() = runBlocking {
        val world = World().with(kbOfA(), kbOfB())
        world.browser().use { browser ->
            live(browser)
            browser.addOpenResource(ResourceId("in-a"), "In A")
            browser.setLastViewedResource(ResourceId("in-a"))

            browser.setActiveKb(KB_B)
            live(browser)
            assertEquals(emptyList<String>(), shown(browser))
            assertNull(browser.lastViewedResource.value)
            browser.addOpenResource(ResourceId("in-b"), "In B")
            browser.setLastViewedResource(ResourceId("in-b"))

            browser.setActiveKb(KB_A)
            live(browser)
            assertEquals(listOf("in-a"), shown(browser))
            assertEquals(ResourceId("in-a"), browser.lastViewedResource.value)
            assertEquals(listOf("in-b"), world.storedOpen(KB_B))
            assertEquals(mapOf(KB_A to "in-a", KB_B to "in-b"), world.storedLastViewed())
        }
    }

    @Test
    fun whatAnotherContextOpensOrViewsIsShownAndNeitherLosesTheOthers() = runBlocking {
        val world = World().with(kbOfA())
        world.browser().use { here ->
            world.browser(world.storage.context()).use { there ->
                live(here)
                live(there)
                here.addOpenResource(ResourceId("from-here"), "Here")
                there.addOpenResource(ResourceId("from-there"), "There")
                there.setLastViewedResource(ResourceId("from-there"))

                // Each wrote against what the storage held, so both are there, in both.
                val both = listOf("from-here", "from-there")
                assertEquals(both, world.storedOpen(KB_A))
                eventually("both are shown in both") { shown(here) == both && shown(there) == both }
                eventually("where the other context is viewing is shown") { here.lastViewedResource.value == ResourceId("from-there") }
            }
        }
    }

    @Test
    fun aChangeToWhatIsOpenIsMadeAgainstWhatTheStorageHolds() = runBlocking {
        val world = World().with(kbOfA())
        world.browser().use { browser ->
            live(browser)
            browser.addOpenResource(ResourceId("mine"), "Mine")
            // Written to the storage with nobody told: a context does not hear what it writes itself, so what the
            // registry has in memory is behind, and what it writes next must not put it back.
            world.storage.set(
                OPEN_RESOURCES_BY_KB_KEY,
                """{"kb-a":[{"id":"mine","name":"Mine","openedAt":1,"order":0},{"id":"theirs","name":"Theirs","openedAt":2,"order":1}]}""",
            )
            world.storage.set(LAST_VIEWED_RESOURCE_BY_KB_KEY, """{"kb-b":"in-b"}""")
            browser.addOpenResource(ResourceId("another"), "Another")
            browser.setLastViewedResource(ResourceId("mine"))

            val want = listOf("mine", "theirs", "another")
            assertEquals(want, world.storedOpen(KB_A))
            assertEquals(want, shown(browser))
            assertEquals(mapOf(KB_A to "mine", KB_B to "in-b"), world.storedLastViewed())
        }
    }

    // What a session's arrival checks.

    @Test
    fun onlyAResourceTheKnowledgeBaseSaysIsGoneIsClosed() = runBlocking {
        val world = World().with(kbOfA())
        world.opened(KB_A, "kept", "gone", "unreadable")
        world.factory.behind.gone += "gone"
        world.factory.behind.failing += "unreadable"
        world.factory.behind.mediaTypes["kept"] = "application/pdf"
        world.browser().use { browser ->
            live(browser)
            eventually("what is gone is closed") { shown(browser) == listOf("kept", "unreadable") }
            assertEquals(listOf("kept", "unreadable"), world.storedOpen(KB_A))
            val tabs = browser.openResources.value
            // What was found is shown under the name and type it has now.
            assertEquals("name-kept" to "application/pdf", tabs[0].name to tabs[0].mediaType)
            // What could not be read is left exactly as it was.
            assertEquals("stale-unreadable", tabs[1].name)
        }
    }

    @Test
    fun whatIsOpenIsCheckedOncePerSessionAndAgainForTheNext() = runBlocking {
        val world = World().with(kbOfA(), kbOfB())
        world.opened(KB_A, "a1", "a2", "a3", "a4", "a5", "a6")
        world.opened(KB_B, "b1")
        world.browser().use { browser ->
            live(browser)
            eventually("every open resource was checked") { world.factory.askedAbout(KB_A).size == 6 }

            // Changing what is open shows the list again, and checks nothing.
            browser.addOpenResource(ResourceId("a7"), "Seven")
            browser.reorderOpenResources(0, 1)
            settle()
            assertEquals(6, world.factory.askedAbout(KB_A).size)

            browser.setActiveKb(KB_B)
            live(browser)
            eventually("B's open resource was checked") { world.factory.askedAbout(KB_B) == listOf("b1") }
        }
    }

    @Test
    fun aResourceAnotherContextOpenedWhileTheChecksRanIsLeftOpen() = runBlocking {
        val world = World().with(kbOfA())
        world.opened(KB_A, "gone")
        world.factory.behind.gone += "gone"
        // The session takes a moment to come up, so the other context writes before it is up.
        world.factory.sessions.answersAfter(300)
        val elsewhere = world.storage.context()
        world.browser().use { browser ->
            delay(50)
            elsewhere.set(
                OPEN_RESOURCES_BY_KB_KEY,
                """{"kb-a":[{"id":"gone","name":"stale-gone","openedAt":0,"order":0},{"id":"sibling","name":"Sibling","openedAt":9,"order":9}]}""",
            )
            live(browser)
            eventually("what is gone is closed and the sibling stays") { shown(browser) == listOf("sibling") }
            assertEquals(listOf("sibling"), world.storedOpen(KB_A))
        }
    }

    @Test
    fun aDifferentKnowledgeBaseAnsweringVoidsWhatWasOpenAndIsRaised() = runBlocking {
        val world = World().with(kbOfA(), kbOfB())
        world.opened(KB_A, "a1", "a2")
        world.opened(KB_B, "b1")
        world.storage.set(LAST_VIEWED_RESOURCE_BY_KB_KEY, """{"kb-a":"a1","kb-b":"b1"}""")
        world.factory.says(KB_A, description("KB B", "example.org:kb-b", "main"))
        world.browser().use { browser ->
            live(browser)
            eventually("the conflict is raised") { conflict(browser) != null }
            assertEquals(emptyList<String>(), shown(browser))
            assertEquals(emptyList<String>(), world.storedOpen(KB_A))
            assertNull(browser.lastViewedResource.value)
            // Only the active one's: the other keeps both.
            assertEquals(listOf("b1"), world.storedOpen(KB_B))
            assertEquals(mapOf(KB_B to "b1"), world.storedLastViewed())
            assertEquals(KbIdentityConflict(DID_A, DID_B), conflict(browser))
            // The entry is as it was written: nothing of the other is put on it.
            assertEquals(kbOfA(), browser.kbs.value[0])
            // And no resource was asked about: those answers would be the wrong one's.
            assertEquals(emptyList<String>(), world.factory.askedAbout(KB_A))
        }
    }

    @Test
    fun theKnowledgeBaseAnsweringAsItselfChangesNothingAndIsRecorded() = runBlocking {
        val world = World().with(kbOfA())
        world.opened(KB_A, "a1")
        world.factory.says(KB_A, description("KB A, as it says", "example.org:kb-a", "main"))
        val entry = world.browser().use { browser ->
            live(browser)
            eventually("what it said is recorded") { browser.kbs.value[0].label == "KB A, as it says" }
            assertEquals(listOf("a1"), shown(browser))
            assertNull(conflict(browser))
            val entry = browser.kbs.value[0]
            assertEquals("main", checkNotNull(entry.lastRead).gitBranch)
            entry
        }
        // And a new registry on the storage reads what was recorded.
        world.browser().use { reopened -> assertEquals(entry, reopened.kbs.value[0]) }
    }

    @ParameterizedTest
    @ValueSource(booleans = [false, true])
    fun noAnswerAndARefusalToSayAreNoVerdictAndVoidNothing(refusing: Boolean) = runBlocking {
        val world = World().with(kbOfA())
        world.opened(KB_A, "a1")
        if (refusing) world.factory.behind.refusing += KB_A
        world.browser().use { browser ->
            live(browser)
            // The resources were checked all the same.
            eventually("the resources were checked") { world.factory.askedAbout(KB_A) == listOf("a1") }
            assertEquals(listOf("a1"), shown(browser))
            assertNull(conflict(browser))
            assertEquals(kbOfA(), browser.kbs.value[0])
            assertEquals(KbReadVerdict(KbReadKind.NoVerdict), browser.readActiveKb())
        }
    }

    @Test
    fun askingTheActiveKnowledgeBaseAgainRecordsWhatItSaysNow() = runBlocking {
        val world = World().with(kbOfA())
        world.factory.says(KB_A, description("KB A", "example.org:kb-a", "main"))
        world.browser().use { browser ->
            live(browser)
            eventually("the session's arrival asked who it is") { world.factory.askedWho(KB_A) == 1 }
            world.factory.says(KB_A, description("KB A", "example.org:kb-a"))
            assertEquals(KbReadVerdict(KbReadKind.Recorded), browser.readActiveKb())
            assertEquals(2, world.factory.askedWho(KB_A))
            // A tree that is on no branch is recorded as on none.
            assertNull(checkNotNull(browser.kbs.value[0].lastRead).gitBranch)
        }
    }

    @Test
    fun askingAgainReportsADifferentKnowledgeBaseAndActsOnNothing() = runBlocking {
        val world = World().with(kbOfA())
        world.opened(KB_A, "a1")
        world.factory.says(KB_A, description("KB A", "example.org:kb-a"))
        world.browser().use { browser ->
            live(browser)
            eventually("the open resource was checked") { world.factory.askedAbout(KB_A) == listOf("a1") }
            browser.setLastViewedResource(ResourceId("a1"))

            world.factory.says(KB_A, description("KB B", "example.org:kb-b"))
            val verdict = browser.readActiveKb()

            assertEquals(KbReadVerdict(KbReadKind.Conflict, DID_B, "KB B"), verdict)
            // Asking is not activating: nothing is voided, and nothing is raised.
            assertEquals(listOf("a1"), shown(browser))
            assertEquals(ResourceId("a1"), browser.lastViewedResource.value)
            assertNull(conflict(browser))
            assertEquals("KB A", browser.kbs.value[0].label)
        }
    }

    @Test
    fun askingAgainDoesNotRaiseAConflictThatWasAcknowledged() = runBlocking {
        val world = World().with(kbOfA())
        world.factory.says(KB_A, description("KB B", "example.org:kb-b"))
        world.browser().use { browser ->
            live(browser)
            eventually("the conflict is raised") { conflict(browser) != null }
            checkNotNull(browser.activeSignals.value).acknowledgeKbIdentityConflict()
            assertEquals(KbReadKind.Conflict, browser.readActiveKb().kind)
            assertNull(conflict(browser))
        }
    }

    @Test
    fun withNoSessionThereIsNothingToAsk() = runBlocking {
        World().browser().use { browser -> assertEquals(KbReadVerdict(KbReadKind.NoVerdict), browser.readActiveKb()) }
    }
}
