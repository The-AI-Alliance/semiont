package semiont.registry

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonIgnoreUnknownKeys

// What a registry of knowledge bases keeps in a SessionStorage, as specs/src/session/stored.json states it.
// StoredTest fails when this differs from the table.

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
 * What is kept of a sign-in: the tokens an issuer issued, the client they
 * were issued to, and the issuer's endpoints a renewal and a sign-out need,
 * learned once at sign-in so no session asks again. Tokens, never a password.
 * A stored value that lacks a member it requires is no session.
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
)
