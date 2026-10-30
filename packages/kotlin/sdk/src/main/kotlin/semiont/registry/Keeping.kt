package semiont.registry

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import semiont.signin.HeldSignIn
import semiont.signin.SignInKept
import semiont.storage.SessionStorage
import semiont.types.KnowledgeBase
import semiont.types.wireJson

/** A stored value as a session; null when it lacks a member a session has. */
private fun sessionIn(stored: String): StoredSession? = try {
    wireJson.decodeFromString(StoredSession.serializer(), stored)
} catch (_: IllegalArgumentException) {
    null
}

private fun writtenOf(session: StoredSession): String = wireJson.encodeToString(StoredSession.serializer(), session)

/** The session stored for a knowledge base; null when none is, or what is stored lacks a member a session has. */
public fun storedSession(storage: SessionStorage, kbId: String): StoredSession? = storage.get(sessionKey(kbId))?.let(::sessionIn)

/** Store a knowledge base's session, in place of what was stored. */
public fun storeSession(storage: SessionStorage, kbId: String, session: StoredSession): Unit = storage.set(sessionKey(kbId), writtenOf(session))

/** Forget a knowledge base's session. */
public fun clearStoredSession(storage: SessionStorage, kbId: String): Unit = storage.delete(sessionKey(kbId))

/**
 * The registered knowledge bases. Each entry is read on its own, and one that
 * is not a knowledge base with a did is dropped: whoever it was is registered
 * again. What an entry holds beyond a knowledge base's members is not read.
 */
public fun loadKnowledgeBases(storage: SessionStorage): List<KnowledgeBase> {
    val stored = storage.get(KNOWLEDGE_BASES_KEY) ?: return emptyList()
    val entries = try {
        wireJson.parseToJsonElement(stored) as? JsonArray
    } catch (_: IllegalArgumentException) {
        null
    } ?: return emptyList()
    return entries.mapNotNull { entry ->
        try {
            wireJson.decodeFromJsonElement(KnowledgeBase.serializer(), entry)
        } catch (_: IllegalArgumentException) {
            null
        }
    }
}

/** Store the registered knowledge bases, in place of what was stored. */
public fun saveKnowledgeBases(storage: SessionStorage, kbs: List<KnowledgeBase>): Unit =
    storage.set(KNOWLEDGE_BASES_KEY, wireJson.encodeToString(ListSerializer(KnowledgeBase.serializer()), kbs))

private fun heldOf(stored: StoredSession) = HeldSignIn(stored.access, stored.refresh, stored.clientId, stored.tokenEndpoint, stored.revocationEndpoint)

private fun storedOf(held: HeldSignIn) = StoredSession(held.access, held.refresh, held.clientId, held.tokenEndpoint, held.revocationEndpoint)

/** A knowledge base's sign-in, kept where a registry keeps it. */
private class KeptIn(private val storage: SessionStorage, private val kbId: String) : SignInKept {
    override suspend fun held(): HeldSignIn? = storedSession(storage, kbId)?.let(::heldOf)

    override suspend fun keep(signIn: HeldSignIn): Unit = storeSession(storage, kbId, storedOf(signIn))

    override suspend fun renewed(read: HeldSignIn, access: String, refresh: String): String? {
        var current: String? = null
        storage.update(sessionKey(kbId)) { stored ->
            val session = stored?.let(::sessionIn)
            when {
                session == null -> {
                    current = null
                    stored
                }
                // Renewed some other way meanwhile: that stands.
                session.access != read.access || session.refresh != read.refresh -> {
                    current = session.access
                    stored
                }
                else -> {
                    current = access
                    writtenOf(session.copy(access = access, refresh = refresh))
                }
            }
        }
        return current
    }

    override suspend fun forget(): Unit = clearStoredSession(storage, kbId)
}

/**
 * A knowledge base's sign-in as a session keeps it, in a registry's storage,
 * under `sessionKey(kbId)`. A renewal is written as one step against what is
 * stored then, so one made meanwhile by another session or context stands.
 */
public fun keptIn(storage: SessionStorage, kbId: String): SignInKept = KeptIn(storage, kbId)
