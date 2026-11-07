package semiont.registry

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.Spec
import semiont.identifiers.ResourceId
import semiont.signin.HeldSignIn
import semiont.storage.MemoryStorage
import semiont.types.HttpEndpoint
import semiont.types.HttpEndpointProtocol
import semiont.types.KnowledgeBase
import semiont.types.wireJson

private val table = Spec.read("session/stored.json").jsonObject
private val session = table.getValue("storedSession").jsonObject
private val members = session.getValue("properties").jsonObject.keys
private val required = session.getValue("required").jsonArray.map { it.jsonPrimitive.content }.toSet()
private val openResource = table.getValue("openResource").jsonObject
private val openMembers = openResource.getValue("properties").jsonObject.keys
private val openRequired = openResource.getValue("required").jsonArray.map { it.jsonPrimitive.content }.toSet()

/** Each key's constant here, by the name the table gives it. */
private val KEYS = mapOf(
    "knowledgeBasesKey" to KNOWLEDGE_BASES_KEY,
    "activeKey" to ACTIVE_KEY,
    "openResourcesByKbKey" to OPEN_RESOURCES_BY_KB_KEY,
    "lastViewedResourceByKbKey" to LAST_VIEWED_RESOURCE_BY_KB_KEY,
    "pendingAuthorizationKey" to PENDING_AUTHORIZATION_KEY,
)

/** What the registry writes of two resources it opens: one with a media type and a storage URI, then one with neither. */
private fun writtenOpen(): List<JsonObject> = runBlocking {
    val world = World().with(kbOfA())
    world.browser().use { browser ->
        live(browser)
        browser.addOpenResource(ResourceId("r1"), "One", "text/plain", "file://docs/one.md")
        browser.addOpenResource(ResourceId("r2"), "Two")
    }
    checkNotNull(world.stored(OPEN_RESOURCES_BY_KB_KEY)).jsonObject.getValue(KB_A).jsonArray.map { it.jsonObject }
}

/**
 * What a registry keeps in its storage, as protocol/specs/src/session/stored.json
 * states it: every key Kotlin writes by hand, the key of a knowledge base's
 * session, the keys of what a session keeps of its stream and its queries, the
 * members of a stored session, and those of an open resource. A key or a member
 * the table gains, or a change to what it requires, fails here until Kotlin
 * has it. And the registry's readers and writers of what it keeps.
 * AuthorizationTest holds what is kept of a sign-in begun.
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
    fun whereAKnowledgeBasesStreamWasIsKeptUnderTheTablesPrefixAndItsId() {
        val prefix = table.getValue("lastEventIdKeyPrefix").jsonObject.getValue("prefix").jsonPrimitive.content
        assertEquals("${prefix}$KB_A", lastEventIdKey(KB_A))
    }

    @Test
    fun aKeptQueryIsKeptUnderTheTablesPrefixItsPersistencesKeyPrefixAndItsName() {
        val prefix = table.getValue("cacheKeyPrefix").jsonObject.getValue("prefix").jsonPrimitive.content
        assertEquals("${prefix}$KB_A.resource", cacheKey(KB_A, "resource"))
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
    fun anOpenResourceIsWrittenWithTheTablesMembersAndNoOthers() {
        val (full, bare) = writtenOpen()
        assertEquals(openMembers, full.keys)
        // One with no media type and no storage URI is written with what the table requires alone.
        assertEquals(openRequired, bare.keys)
    }

    @TestFactory
    fun aStoredOpenResourceWithoutAMemberIsOneOnlyIfTheTableDoesNotRequireIt(): List<DynamicTest> {
        val full = writtenOpen().first()
        return openMembers.map { member ->
            DynamicTest.dynamicTest(member) {
                val lacking = JsonObject(full - member)
                if (member in openRequired) {
                    assertThrows(SerializationException::class.java) { wireJson.decodeFromJsonElement(OpenResource.serializer(), lacking) }
                } else {
                    wireJson.decodeFromJsonElement(OpenResource.serializer(), lacking)
                }
            }
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
