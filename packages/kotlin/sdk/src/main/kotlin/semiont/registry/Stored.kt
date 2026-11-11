package semiont.registry

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonIgnoreUnknownKeys
import kotlinx.serialization.json.JsonPrimitive
import semiont.Timings
import semiont.bus.faultOfSchema
import semiont.cache.Cache
import semiont.cache.CacheQuery
import semiont.cache.KeptCaches
import semiont.cache.PERSISTED_QUERIES
import semiont.http.codeChallenge
import semiont.storage.CachePersistence
import semiont.storage.SessionStorage
import semiont.storage.StoragePersister

// What a registry of knowledge bases keeps in a SessionStorage, and what its sessions keep there of their queries and
// their stream, as protocol/specs/src/session/stored.json states it. StoredTest fails when this differs from the table,
// and CacheCasesTest when what a session keeps differs from session/cache-cases.json.

/** The registered knowledge bases: a JSON list of `KnowledgeBase`. */
public const val KNOWLEDGE_BASES_KEY: String = "semiont.knowledgeBases"

/** The id of the active knowledge base. Nothing is kept under it while none is active. */
public const val ACTIVE_KEY: String = "semiont.activeKnowledgeBaseId"

/** What is open in each knowledge base: a JSON object from a knowledge base's id to the list of its open resources. */
public const val OPEN_RESOURCES_BY_KB_KEY: String = "semiont.openResourcesByKb"

/** Where the person was in each knowledge base: a JSON object from a knowledge base's id to the id of the resource last viewed in it. */
public const val LAST_VIEWED_RESOURCE_BY_KB_KEY: String = "semiont.lastViewedResourceByKb"

/**
 * A sign-in by a page redirect that is under way: what it remembers across
 * the trip to the issuer and back. It is taken when the sign-in completes, so
 * a callback that is replayed finds nothing to complete.
 */
public const val PENDING_AUTHORIZATION_KEY: String = "semiont.pendingAuthorization"

private const val SESSION_KEY_PREFIX = "semiont.session."

/** The key a knowledge base's session is kept under. */
public fun sessionKey(kbId: String): String = SESSION_KEY_PREFIX + kbId

/** The knowledge base a key is the session of; null when it is no session's key. */
public fun kbOfSessionKey(key: String): String? = if (key.startsWith(SESSION_KEY_PREFIX)) key.removePrefix(SESSION_KEY_PREFIX) else null

/**
 * The key of the person the gateway says a token is, by their did: what names
 * them in the keys their client's caches and stream places are kept under, and
 * in a stored sign-in, in place of the did itself. Unpadded base64url of the
 * SHA-256 of the did's UTF-8.
 */
public fun personKey(did: String): String = codeChallenge(did)

/** The key the stream's places in each scope of knowledge base `kbId` are kept under, as `lastEventIds`, for the person whose key is `personKey`. */
internal fun lastEventIdKey(kbId: String, personKey: String): String = "semiont.lastEventId.$kbId.$personKey"

/** The schema each place `lastEventIds` keeps is a value of. */
internal const val PLACE_SCHEMA: String = "PersistedEventId"

/** Whether `id` is a PersistedEventId: the id of a recorded event, and the one kind of id that is a stream's place. */
internal fun isPersistedEventId(id: String): Boolean = faultOfSchema(PLACE_SCHEMA, JsonPrimitive(id)) == null

/** The key the query `query` of knowledge base `kbId` is kept under, for the person whose key is `personKey`. */
internal fun cacheKey(kbId: String, personKey: String, query: String): String = "semiont.cache.$kbId.$personKey.$query"

/**
 * Delete what a client kept of knowledge base `kbId` for the person whose key
 * is `personKey`: every persisted query's key and the stream's places. What
 * forgetting a saved sign-in that named them deletes, whether it is cleared
 * or a new sign-in is kept in its place.
 */
internal fun forgetKept(storage: SessionStorage, kbId: String, personKey: String) {
    PERSISTED_QUERIES.forEach { storage.delete(cacheKey(kbId, personKey, it.query.wire)) }
    storage.delete(lastEventIdKey(kbId, personKey))
}

/** The form of a kept query's document, `cacheDocument`: `{version, entries}`, each entry a key, a value and its stamp. */
internal const val CACHE_DOCUMENT_VERSION: Long = 1

/** The key of a query per nothing: the one entry a kept one keeps is kept under it. */
internal const val WHOLE_KEY: String = "_"

/** The key of a kept query per nothing, as its document writes it: `WHOLE_KEY`, and no other text. */
internal object WholeKeySerializer : KSerializer<String> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("semiont.registry.WholeKey", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: String): Unit = encoder.encodeString(value)

    override fun deserialize(decoder: Decoder): String {
        val json = decoder as? JsonDecoder ?: throw SerializationException("the key of a query per nothing is read from JSON alone")
        val key = json.decodeJsonElement()
        if (key !is JsonPrimitive || !key.isString || key.content != WHOLE_KEY) throw SerializationException("$key is not the key of a query per nothing")
        return key.content
    }
}

/**
 * A query a client keeps across a restart (a row client/refresh.json marks
 * `persisted`, as `PERSISTED_QUERIES` has each): its name in that table, what
 * its entries' keys and values are, and which of a client's caches it is.
 */
internal class KeptQuery<K : Any, V : Any>(
    val query: CacheQuery,
    val key: KSerializer<K>,
    val value: KSerializer<V>,
    private val cache: (KeptCaches) -> Cache<K, V>,
) {
    /** What keeps the query's cache in `persistence`: one document, under the query's name, for the persistence's person. */
    fun persister(persistence: CachePersistence): StoragePersister<K, V> =
        StoragePersister(persistence.storage, cacheKey(persistence.kbId, persistence.personKey, query.wire), key, value, CACHE_DOCUMENT_VERSION, Timings.MAX_STORED_BYTES_COUNT)

    /** The query's cache among `caches`. */
    fun cacheIn(caches: KeptCaches): Cache<K, V> = cache(caches)

    /** Keep the query's cache among `caches` in `persistence` from now on. */
    fun attach(caches: KeptCaches, persistence: CachePersistence): Unit = cache(caches).attach(persister(persistence))
}

/**
 * What is kept of a sign-in: the tokens an issuer issued, the client they
 * were issued to, the issuer's endpoints a renewal and a sign-out need,
 * learned once at sign-in so no session asks again, and whom the gateway said
 * the tokens are, once it has. Tokens, never a password. A stored value that
 * lacks a member it requires is no session.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonIgnoreUnknownKeys
public data class StoredSession(
    /** The access token: short-lived, sent as a Bearer token. */
    public val access: String,
    /** The refresh token: what renews the access token at the issuer without another sign-in. */
    public val refresh: String,
    /** The client the tokens were issued to, which a renewal and a revocation name. */
    public val clientId: String,
    /** The issuer's token endpoint, where the refresh grant is made. */
    public val tokenEndpoint: String,
    /** The issuer's revocation endpoint (RFC 7009), where a sign-out tells it to forget the refresh token. Null when the issuer has none. */
    public val revocationEndpoint: String? = null,
    /** The key of the person the gateway said this sign-in's token is (`personKey`). Null until a gateway has named them: a renewal keeps it, a new sign-in has none. */
    public val personKey: String? = null,
)
