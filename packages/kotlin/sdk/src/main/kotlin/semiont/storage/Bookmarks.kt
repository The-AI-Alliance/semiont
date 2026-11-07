package semiont.storage

import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import semiont.http.Bookmarks
import semiont.identifiers.ResourceId
import semiont.registry.isPersistedEventId
import semiont.types.wireJson

/**
 * A stream's place in each scope, kept in `storage` under `key` as
 * session/stored.json's `lastEventIds`, so the next client of the same
 * knowledge base resumes from it, and what that client kept of a scope is
 * brought up to date by the events recorded since, replayed.
 *
 * The place may lag the caches and never leads them: a place kept ahead of a
 * cache would have the next client resume past an event the cache it begins
 * with never took in. So a place is not written when it is reached. It is
 * remembered, and written with the next write of a cache, when the gate
 * (`flushGate`) says every kept cache is at rest and nothing is owed a
 * refetch. A place that is not written is only late, which costs a replay.
 * When its client begins to close (`freeze`), the gate is read once more and
 * no longer, and the flush closing makes writes only the places remembered by
 * then: none, if a kept cache was fetching or a refetch was owed, since
 * closing drops them; a save owed does not hold them back, since that flush is
 * the save. A place remembered after the reading is of an event whose refetch
 * closing drops, and is not kept. Only a PersistedEventId is a place, and none
 * other is remembered: a pair kept under the key that is not a resource's id
 * and a PersistedEventId is not read, and a value that is no object is no
 * places.
 */
public class CoupledBookmarks(private val beneath: SessionStorage, private val key: String) : Bookmarks {
    private val pending = LinkedHashMap<ResourceId, String>()

    /** Whether the client has begun to close: from then on no place is remembered, and the gate is not read again. Guarded by `pending`. */
    private var closing = false

    /** Whether a place may be written now: every kept cache is at rest, and nothing is owed a refetch. With none, every write of a cache carries what is remembered. */
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

    override fun load(): Map<ResourceId, String> {
        val kept = try {
            wireJson.parseToJsonElement(beneath.get(key) ?: return emptyMap())
        } catch (_: SerializationException) {
            return emptyMap()
        }
        if (kept !is JsonObject) return emptyMap()
        val places = LinkedHashMap<ResourceId, String>()
        for ((scope, place) in kept) {
            val resource = ResourceId.parse(scope) ?: continue
            val eventId = (place as? JsonPrimitive)?.takeIf { it.isString }?.content ?: continue
            if (isPersistedEventId(eventId)) places[resource] = eventId
        }
        return places
    }

    override fun save(scope: ResourceId, eventId: String) {
        if (isPersistedEventId(eventId)) synchronized(pending) { if (!closing) pending[scope] = eventId }
    }

    /**
     * The client begins to close: `nothingDropped`, whether closing drops no
     * fetch and no refetch, is read once, in one step with the places a flush
     * may yet write. They are those remembered until now if it holds, and none
     * if not. Closing twice is closing once.
     */
    internal fun freeze(nothingDropped: () -> Boolean) {
        synchronized(pending) {
            if (closing) return
            closing = true
            if (!nothingDropped()) pending.clear()
        }
    }

    /** Write what is remembered, when the gate allows it, or once the client has begun to close, what `freeze` left. */
    private fun flush() {
        val reached = synchronized(pending) {
            if (pending.isEmpty() || (!closing && flushGate?.invoke() == false)) return
            LinkedHashMap(pending).also { pending.clear() }
        }
        beneath.set(key, wireJson.encodeToString(MapSerializer(ResourceId.serializer(), String.serializer()), load() + reached))
    }
}
