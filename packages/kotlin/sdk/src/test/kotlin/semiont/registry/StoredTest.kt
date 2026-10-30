package semiont.registry

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.Spec
import semiont.signin.HeldSignIn
import semiont.storage.MemoryStorage
import semiont.types.HttpEndpoint
import semiont.types.HttpEndpointProtocol
import semiont.types.KnowledgeBase

private val table = Spec.read("session/stored.json").jsonObject
private val session = table.getValue("storedSession").jsonObject
private val members = session.getValue("properties").jsonObject.keys
private val required = session.getValue("required").jsonArray.map { it.jsonPrimitive.content }.toSet()

/** Each key's constant here, by the name the table gives it. */
private val KEYS = mapOf(
    "knowledgeBasesKey" to KNOWLEDGE_BASES_KEY,
    "activeKey" to ACTIVE_KEY,
    "openResourcesByKbKey" to OPEN_RESOURCES_BY_KB_KEY,
    "lastViewedResourceByKbKey" to LAST_VIEWED_RESOURCE_BY_KB_KEY,
    "pendingAuthorizationKey" to PENDING_AUTHORIZATION_KEY,
)

/**
 * What a registry keeps in its storage, as specs/src/session/stored.json
 * states it: every key Kotlin writes by hand, the key of a knowledge base's
 * session, and the members of a stored session. A key or a member the table
 * gains fails here until Kotlin has it. And the registry's readers and
 * writers of what it keeps.
 */
class StoredTest {
    @Test
    fun eachKeyIsTheTablesAndTheTableHasNoneKotlinLacks() {
        val stated = table.getValue("keys").jsonArray.map { it.jsonObject }
        assertEquals(stated.associate { it.getValue("member").jsonPrimitive.content to it.getValue("key").jsonPrimitive.content }, KEYS)
    }

    @Test
    fun aKnowledgeBasesSessionIsKeptUnderTheTablesPrefixAndItsId() {
        val prefix = table.getValue("sessionKeyPrefix").jsonObject.getValue("prefix").jsonPrimitive.content
        assertEquals("${prefix}$KB_A", sessionKey(KB_A))
        assertEquals(KB_A, kbOfSessionKey(sessionKey(KB_A)))
        assertNull(kbOfSessionKey(ACTIVE_KEY))
    }

    @Test
    fun aStoredSessionIsWrittenWithTheTablesMembersAndNoOthers() {
        val storage = MemoryStorage()
        storeSession(storage, KB_A, StoredSession("a", "r", "semiont-browser", "https://issuer.test/token", "https://issuer.test/revoke"))
        assertEquals(members, Json.parseToJsonElement(checkNotNull(storage.get(sessionKey(KB_A)))).jsonObject.keys)
        // One with no revocation endpoint is written without it.
        storeSession(storage, KB_A, StoredSession("a", "r", "semiont-browser", "https://issuer.test/token"))
        assertEquals(members - "revocationEndpoint", Json.parseToJsonElement(checkNotNull(storage.get(sessionKey(KB_A)))).jsonObject.keys)
    }

    @TestFactory
    fun aStoredValueWithoutAMemberIsASessionOnlyIfTheTableDoesNotRequireIt(): List<DynamicTest> = members.map { member ->
        DynamicTest.dynamicTest(member) {
            val storage = MemoryStorage()
            storage.set(sessionKey(KB_A), JsonObject((members - member).associateWith { JsonPrimitive("the $it") }).toString())
            val read = storedSession(storage, KB_A)
            if (member in required) assertNull(read) else assertNotNull(read)
        }
    }

    @Test
    fun aStoredValueThatLacksAMemberOfASessionIsNone() {
        val storage = MemoryStorage()
        assertNull(storedSession(storage, KB_A))
        storage.set(sessionKey(KB_A), """{"access":"a","refresh":"r","tokenEndpoint":"https://issuer.test/token"}""")
        assertNull(storedSession(storage, KB_A))
        storage.set(sessionKey(KB_A), "not json")
        assertNull(storedSession(storage, KB_A))
        storage.set(sessionKey(KB_A), """{"access":"a","refresh":"r","clientId":"semiont-browser","tokenEndpoint":"https://issuer.test/token"}""")
        assertNull(checkNotNull(storedSession(storage, KB_A)).revocationEndpoint)
        clearStoredSession(storage, KB_A)
        assertNull(storage.get(sessionKey(KB_A)))
    }

    @Test
    fun aRenewalIsKeptAgainstWhatIsStoredThen() = runBlocking {
        val storage = MemoryStorage()
        val kept = keptIn(storage, KB_A)
        val read = HeldSignIn("a1", "r1", "semiont-browser", "https://issuer.test/token", null)

        // A renewal of nothing stored is not kept, and writes nothing.
        assertNull(kept.renewed(read, "a2", "r2"))
        assertNull(storedSession(storage, KB_A))

        kept.keep(read)
        assertEquals("a2", kept.renewed(read, "a2", "r2"))
        assertEquals("a2" to "r2", checkNotNull(kept.held()).let { it.access to it.refresh })

        // Renewed from what was read before: the renewal stored meanwhile stands.
        assertEquals("a2", kept.renewed(read, "a3", "r3"))
        assertEquals("a2", checkNotNull(kept.held()).access)

        kept.forget()
        assertNull(kept.held())
    }

    @Test
    fun anEntryThatIsNotAKnowledgeBaseWithADidIsNotReadAndWhatItCarriesBeyondOneIsNot() {
        val storage = MemoryStorage()
        assertEquals(emptyList<KnowledgeBase>(), loadKnowledgeBases(storage))
        storage.set(
            KNOWLEDGE_BASES_KEY,
            """[
                {"id":"old","label":"No did","endpoint":{"kind":"http","host":"localhost","port":4000,"protocol":"http"}},
                {"id":"kb-a","label":"KB A","did":"did:web:example.org:kb-a","email":"someone@example.org",
                 "endpoint":{"kind":"http","host":"localhost","port":4000,"protocol":"http"}},
                "not an entry"
            ]""",
        )
        val kbA = KnowledgeBase(KB_A, "KB A", HttpEndpoint(host = "localhost", port = 4000, protocol = HttpEndpointProtocol.Http), "did:web:example.org:kb-a")
        assertEquals(listOf(kbA), loadKnowledgeBases(storage))
        saveKnowledgeBases(storage, loadKnowledgeBases(storage))
        assertEquals(
            Json.parseToJsonElement("""[{"id":"kb-a","label":"KB A","endpoint":{"kind":"http","host":"localhost","port":4000,"protocol":"http"},"did":"did:web:example.org:kb-a"}]"""),
            Json.parseToJsonElement(checkNotNull(storage.get(KNOWLEDGE_BASES_KEY))),
        )
        // What does not read as a list is no knowledge bases.
        storage.set(KNOWLEDGE_BASES_KEY, """{"id":"kb-a"}""")
        assertEquals(emptyList<KnowledgeBase>(), loadKnowledgeBases(storage))
    }
}
