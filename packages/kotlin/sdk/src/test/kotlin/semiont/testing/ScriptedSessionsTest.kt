package semiont.testing

import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import semiont.registry.SessionFactoryOptions
import semiont.session.SessionSignals
import semiont.storage.MemoryStorage
import semiont.types.KnowledgeBase
import semiont.types.LocalEndpoint
import kotlin.time.Duration.Companion.seconds

class ScriptedSessionsTest {
    @Test
    fun aRenewalASessionAsksForIsTheOneScriptedAndIsCounted() = runTest(timeout = 10.seconds) {
        val sessions = ScriptedSessions()
        sessions.queueRenewals("renewed-1")
        val signals = SessionSignals()
        val kb = KnowledgeBase(id = "kb-a", label = "KB A", endpoint = LocalEndpoint(kbId = "kb-a"), did = "did:web:kb.example")
        val opened = sessions.session(SessionFactoryOptions(kb, MemoryStorage(), signals) {})
        assertEquals(0, sessions.renewed)
        assertEquals("renewed-1", opened.session.refresh())
        assertEquals(1, sessions.renewed)
        opened.close()
        signals.close()
    }
}
