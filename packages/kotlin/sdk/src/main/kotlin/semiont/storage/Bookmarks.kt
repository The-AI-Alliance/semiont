package semiont.storage

import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import semiont.http.Bookmarks
import semiont.identifiers.ResourceId
import semiont.types.wireJson

/**
 * A stream's place in each scope, kept in `storage` under `key`, so the next
 * client of the same knowledge base resumes from it, and what that client kept
 * of a scope is brought up to date by the events recorded since, replayed.
 *
 * The place may lag the caches and never leads them: a place kept ahead of a
 * cache would have the next client resume past an event the cache it begins
 * with never took in. So a place is not written when it is reached. It is
 * remembered, and written with the next write of a cache, when the gate
 * (`flushGate`) says every kept cache is at rest. A place that is not written
 * is only late, which costs a replay. What is kept under the key and is not
 * places reads as nothing kept.
 */
public class CoupledBookmarks(private val beneath: SessionStorage, private val key: String) : Bookmarks {
    private val pending = LinkedHashMap<ResourceId, String>()

    /** Whether the caches are at rest. With none, every write of a cache carries what is remembered. */
    @Volatile
    public var flushGate: (() -> Boolean)? = null

    /** The storage to give the caches: what they write goes to the storage beneath, and carries the places with it. */
    public val storage: SessionStorage = object : SessionStorage {
        override fun get(key: String): String? = beneath.get(key)

        override fun set(key: String, value: String) {
            beneath.set(key, value)
            flush()
        }

        override fun delete(key: String): Unit = beneath.delete(key)

        override fun update(key: String, change: (String?) -> String?) {
            beneath.update(key, change)
            flush()
        }

        override fun subscribe(onChange: (key: String, value: String?) -> Unit): AutoCloseable? = beneath.subscribe(onChange)
    }

    override fun load(): Map<ResourceId, String> = beneath.get(key)?.let { kept ->
        try {
            wireJson.decodeFromString(MapSerializer(ResourceId.serializer(), String.serializer()), kept)
        } catch (_: IllegalArgumentException) {
            null
        }
    } ?: emptyMap()

    override fun save(scope: ResourceId, eventId: String): Unit = synchronized(pending) { pending[scope] = eventId }

    /** Write what is remembered, when the gate allows it. */
    private fun flush() {
        val reached = synchronized(pending) {
            if (pending.isEmpty() || flushGate?.invoke() == false) return
            LinkedHashMap(pending).also { pending.clear() }
        }
        beneath.set(key, wireJson.encodeToString(MapSerializer(ResourceId.serializer(), String.serializer()), load() + reached))
    }
}
