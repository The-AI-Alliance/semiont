package semiont.registry

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.Spec
import semiont.cache.PERSISTED_QUERIES
import semiont.identifiers.AnnotationId
import semiont.identifiers.ResourceId
import semiont.signin.HeldSignIn
import semiont.signin.namingIsRecordedOnTheSignInAskedAbout
import semiont.storage.CachePersistence
import semiont.storage.CoupledBookmarks
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
private val keptQueries = table.getValue("keptQueries").jsonArray.map { it.jsonObject }
private val wholeKey = table.getValue("wholeKey").jsonObject.getValue("key").jsonPrimitive.content
private val cacheDocument = table.getValue("cacheDocument").jsonObject
private val lastEventIds = table.getValue("lastEventIds").jsonObject

/** The component schema a `$ref` of the table names. */
private fun schemaOf(ref: JsonObject): String = ref.getValue("\$ref").jsonPrimitive.content.substringBefore('#').substringAfterLast('/').removeSuffix(".json")

/** What a `$ref` of the table names, as Kotlin decodes it: a component schema's type, or the type of one member of one. */
private fun descriptorOf(ref: JsonObject): SerialDescriptor {
    val component = serializer(Class.forName("semiont.types.${schemaOf(ref)}")).descriptor
    val pointer = ref.getValue("\$ref").jsonPrimitive.content.substringAfter('#', "")
    if (pointer.isEmpty()) return component
    return component.getElementDescriptor(component.getElementIndex(pointer.removePrefix("/properties/")))
}

private fun JsonObject.text(name: String): String = getValue(name).jsonPrimitive.content

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
 * session, the keys of what a session keeps of its stream and its queries for
 * one person, each the table's example, the members of a stored session, and
 * those of an open resource; and the queries a session keeps, what each is
 * keyed by and keeps, the document each is kept as, and what is kept of its
 * stream. A key or a member the table gains, or a change to what it requires,
 * fails here until Kotlin has it. And the registry's readers and writers of
 * what it keeps. AuthorizationTest holds what is kept of a sign-in begun;
 * PersistedCasesTest, when each person's keys are read, written and deleted;
 * and CacheCasesTest, what a session keeps of its queries and its stream,
 * case by case.
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
    fun whereAKnowledgeBasesStreamWasForOnePersonIsKeptUnderTheKeyOfTheTablesExample() {
        val example = table.getValue("lastEventIdKeyPrefix").jsonObject.getValue("example").jsonObject
        assertEquals(example.text("key"), lastEventIdKey(example.text("kbId"), personKey(example.text("did"))))
    }

    @Test
    fun aKeptQueryForOnePersonIsKeptUnderTheKeyOfTheTablesExample() {
        val example = table.getValue("cacheKeyPrefix").jsonObject.getValue("example").jsonObject
        assertEquals(example.text("key"), cacheKey(example.text("kbId"), personKey(example.text("did")), example.text("query")))
    }

    @Test
    fun theQueriesASessionKeepsAreTheTablesEachByItsNameAndKeepingWhatTheTableSays() {
        assertEquals(keptQueries.map { it.getValue("query").jsonPrimitive.content }.toSet(), KEPT_QUERIES.map { it.query.wire }.toSet())
        for (stated in keptQueries) {
            val kept = KEPT_QUERIES.single { it.query.wire == stated.getValue("query").jsonPrimitive.content }
            assertEquals(descriptorOf(stated.getValue("value").jsonObject), kept.value.descriptor, kept.query.wire)
        }
    }

    @TestFactory
    fun eachKeptQueryIsKeyedByWhatTheRefreshTableSaysItIsPer(): List<DynamicTest> {
        val per = Spec.read("client/refresh.json").jsonObject.getValue("queries").jsonArray.map { it.jsonObject }
            .associate { it.getValue("name").jsonPrimitive.content to it["per"]?.jsonPrimitive?.content }
        return KEPT_QUERIES.map { kept ->
            DynamicTest.dynamicTest(kept.query.wire) {
                when (val of = per.getValue(kept.query.wire)) {
                    "resource" -> assertEquals(ResourceId.serializer().descriptor, kept.key.descriptor)
                    "annotation" -> assertEquals(AnnotationId.serializer().descriptor, kept.key.descriptor)
                    // A query per nothing keeps its one entry under the table's whole key, and under no other.
                    null -> {
                        assertEquals(wholeKey, WHOLE_KEY)
                        assertEquals(wholeKey, wireJson.decodeFromJsonElement(kept.key, JsonPrimitive(wholeKey)))
                        assertThrows(SerializationException::class.java) { wireJson.decodeFromJsonElement(kept.key, JsonPrimitive("$wholeKey$wholeKey")) }
                    }
                    else -> throw AssertionError("${kept.query.wire} is kept, and is per $of, which no kept query is")
                }
            }
        }
    }

    @Test
    fun aKeptQuerysDocumentIsWrittenWithTheTablesMembersAndNoOthers() {
        val version = cacheDocument.getValue("properties").jsonObject.getValue("version").jsonObject.getValue("const").jsonPrimitive.content.toLong()
        assertEquals(version, CACHE_DOCUMENT_VERSION)
        val storage = MemoryStorage()
        val resource = ResourceId("r1")
        KEPT_RESOURCE.persister(CachePersistence(storage, KB_A, "the key of jo")).save(
            mapOf(resource to wireJson.decodeFromString(KEPT_RESOURCE.value, """{"@context":"https://schema.org/","@id":"r1","name":"One","representations":[]}""")),
        )
        val written = Json.parseToJsonElement(checkNotNull(storage.get(cacheKey(KB_A, "the key of jo", KEPT_RESOURCE.query.wire)))).jsonObject
        assertEquals(cacheDocument.getValue("properties").jsonObject.keys, written.keys)
        assertEquals(version, written.getValue("version").jsonPrimitive.content.toLong())
        val items = cacheDocument.getValue("properties").jsonObject.getValue("entries").jsonObject.getValue("items").jsonObject
        assertEquals(items.getValue("prefixItems").jsonArray.size, written.getValue("entries").jsonArray.single().jsonArray.size)
    }

    @Test
    fun whereAStreamWasIsKeptAsTheTableSaysFromEachScopeToItsPlace() {
        assertEquals(ResourceId.serializer().descriptor.serialName.substringAfterLast('.'), schemaOf(lastEventIds.getValue("propertyNames").jsonObject))
        assertEquals(PLACE_SCHEMA, schemaOf(lastEventIds.getValue("additionalProperties").jsonObject))
        val storage = MemoryStorage()
        val places = CoupledBookmarks(storage, lastEventIdKey(KB_A, "the key of jo"))
        places.save(ResourceId("r1"), "p-r1-7")
        places.storage.set(cacheKey(KB_A, "the key of jo", KEPT_RESOURCE.query.wire), "{}")
        assertEquals(Json.parseToJsonElement("""{"r1":"p-r1-7"}"""), Json.parseToJsonElement(checkNotNull(storage.get(lastEventIdKey(KB_A, "the key of jo")))))
    }

    @Test
    fun aStoredSessionIsWrittenWithTheTablesMembersAndNoOthers() {
        val storage = MemoryStorage()
        storeSession(storage, KB_A, StoredSession("a", "r", "semiont-browser", "https://issuer.test/token", "https://issuer.test/revoke", "the key of jo"))
        assertEquals(members, Json.parseToJsonElement(checkNotNull(storage.get(sessionKey(KB_A)))).jsonObject.keys)
        // One with no revocation endpoint, and whose person the gateway has not named, is written without either.
        storeSession(storage, KB_A, StoredSession("a", "r", "semiont-browser", "https://issuer.test/token"))
        assertEquals(members - "revocationEndpoint" - "personKey", Json.parseToJsonElement(checkNotNull(storage.get(sessionKey(KB_A)))).jsonObject.keys)
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
        assertNull(checkNotNull(storedSession(storage, KB_A)).personKey)
        clearStoredSession(storage, KB_A)
        assertNull(storage.get(sessionKey(KB_A)))
    }

    @Test
    fun clearingAStoredSessionDeletesWhatWasKeptForThePersonItNamedAndNoOtherPersons() {
        val storage = MemoryStorage()
        val keptForJo = listOf(cacheKey(KB_A, "the key of jo", "resource"), lastEventIdKey(KB_A, "the key of jo"))
        val keptForAnn = cacheKey(KB_A, "the key of ann", "resource")
        for (key in keptForJo + keptForAnn) storage.set(key, "{}")
        storeSession(storage, KB_A, tokens("r").copy(personKey = "the key of jo"))
        clearStoredSession(storage, KB_A)
        for (key in keptForJo) assertNull(storage.get(key), key)
        assertEquals("{}", storage.get(keptForAnn))
    }

    @Test
    fun keepingANewSignInInPlaceOfOneThatNamesItsPersonDeletesWhatWasKeptForThemAndNoOtherPersons() = runBlocking {
        val storage = MemoryStorage()
        val kept = keptIn(storage, KB_A)
        val keptForJo = PERSISTED_QUERIES.map { cacheKey(KB_A, "the key of jo", it.wire) } + lastEventIdKey(KB_A, "the key of jo")
        val keptForOthers = listOf(cacheKey(KB_A, "the key of ann", "resource"), cacheKey(KB_B, "the key of jo", "resource"), lastEventIdKey(KB_B, "the key of jo"))
        fun signIn(access: String, refresh: String, personKey: String?) = HeldSignIn(access, refresh, "semiont-browser", "https://issuer.test/token", null, personKey)

        // A new sign-in names nobody until its gateway names them: the person the replaced one named is forgotten.
        for (key in keptForJo + keptForOthers) storage.set(key, "{}")
        storeSession(storage, KB_A, tokens("r").copy(personKey = "the key of jo"))
        kept.keep(signIn("a2", "r2", null))
        assertEquals(signIn("a2", "r2", null), kept.held())
        for (key in keptForJo) assertNull(storage.get(key), key)
        for (key in keptForOthers) assertEquals("{}", storage.get(key), key)

        // In place of one that names nobody, or of nothing, nothing is known to be anyone's: nothing is deleted.
        for (key in keptForJo) storage.set(key, "{}")
        kept.keep(signIn("a3", "r3", null))
        assertEquals(signIn("a3", "r3", null), kept.held())
        kept.forget()
        kept.keep(signIn("a4", "r4", null))
        assertEquals(signIn("a4", "r4", null), kept.held())
        for (key in keptForJo + keptForOthers) assertEquals("{}", storage.get(key), key)
    }

    @Test
    fun aRenewalIsKeptAgainstWhatIsStoredThen() = runBlocking {
        val storage = MemoryStorage()
        val kept = keptIn(storage, KB_A)
        val read = HeldSignIn("a1", "r1", "semiont-browser", "https://issuer.test/token", null, "the key of jo")

        // A renewal of nothing stored is not kept, and writes nothing.
        assertNull(kept.renewed(read, "a2", "r2"))
        assertNull(storedSession(storage, KB_A))

        kept.keep(read)
        assertEquals("a2", kept.renewed(read, "a2", "r2"))
        // The renewal keeps whom the sign-in names.
        assertEquals(read.copy(access = "a2", refresh = "r2"), kept.held())

        // Renewed from what was read before: the renewal stored meanwhile stands.
        assertEquals("a2", kept.renewed(read, "a3", "r3"))
        assertEquals("a2", checkNotNull(kept.held()).access)

        kept.forget()
        assertNull(kept.held())
    }

    @Test
    fun whoTheGatewayNamedIsRecordedOnTheStoredSignInItWasAskedAbout() = runBlocking {
        val storage = MemoryStorage()
        namingIsRecordedOnTheSignInAskedAbout(keptIn(storage, KB_A))
        // Recorded in the stored session, under the table's member.
        assertEquals("the key of ann", checkNotNull(storedSession(storage, KB_A)).personKey)
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
