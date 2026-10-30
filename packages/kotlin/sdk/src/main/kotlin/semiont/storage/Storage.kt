package semiont.storage

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import semiont.cache.CachePersister
import semiont.types.wireJson
import java.util.concurrent.ConcurrentHashMap

/**
 * Where a client keeps what must outlive it: text under a key. The seam an
 * application fills in (a file, a platform's store), so nothing above it knows
 * where it runs.
 */
public interface SessionStorage {
    /** What is stored under `key`, when anything is. */
    public fun get(key: String): String?

    /** Store `value` under `key`, in place of what was there. */
    public fun set(key: String, value: String)
}

/** A `SessionStorage` kept in memory, for as long as the process lives: a client that closes and one that opens after it, over the same storage, are a reload. */
public class MemoryStorage : SessionStorage {
    private val stored = ConcurrentHashMap<String, String>()

    override fun get(key: String): String? = stored[key]

    override fun set(key: String, value: String) {
        stored[key] = value
    }
}

/** Where a client keeps what its queries hold, so the next client of the same knowledge base shows it at once: documents in `storage`, under `semiont.cache.<keyPrefix>.<query>`. */
public class CachePersistence(public val storage: SessionStorage, public val keyPrefix: String)

/**
 * A cache's values in `storage`, under `storageKey`, as one document:
 * `{version, writtenAt, entries}`, each entry a key, its value, and when that
 * value was last written. `key` and `value` say how each is read and written,
 * `version` which documents are this cache's to read, and `maxBytes` how large
 * the document may be. A document of another version, or one that does not
 * parse, reads as nothing kept; an entry that is not this cache's shape is one
 * it never kept. A document larger than it may be loses the entries that have
 * gone longest without a new value, until it fits.
 */
public class StoragePersister<K : Any, V : Any>(
    private val storage: SessionStorage,
    private val storageKey: String,
    private val key: KSerializer<K>,
    private val value: KSerializer<V>,
    private val version: Long,
    private val maxBytes: Long,
) : CachePersister<K, V> {
    /** Each key's value as last written, and when: an entry whose value has not changed keeps its time. */
    private var written = mapOf<String, Pair<String, Long>>()

    override fun load(): Map<K, V>? {
        val document = storage.get(storageKey)?.let { runCatching { wireJson.parseToJsonElement(it) }.getOrNull() } as? JsonObject ?: return null
        val entries = document["entries"] as? JsonArray
        if ((document["version"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull != version || entries == null) return null
        val kept = LinkedHashMap<K, V>()
        val writtenNow = LinkedHashMap<String, Pair<String, Long>>()
        for (entry in entries) {
            val stated = entry as? JsonArray ?: continue
            val at = (stated.getOrNull(2) as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
            if (stated.size != 3 || at == null) continue
            try {
                kept[wireJson.decodeFromJsonElement(key, stated[0])] = wireJson.decodeFromJsonElement(value, stated[1])
            } catch (_: IllegalArgumentException) {
                continue
            }
            writtenNow[stated[0].toString()] = stated[1].toString() to at
        }
        written = writtenNow
        return kept
    }

    override fun save(entries: Map<K, V>) {
        val now = System.currentTimeMillis()
        val stored = entries.map { (k, v) ->
            val keyText = wireJson.encodeToJsonElement(key, k).toString()
            val valueText = wireJson.encodeToJsonElement(value, v).toString()
            val before = written[keyText]
            Triple(keyText, valueText, if (before != null && before.first == valueText) before.second else now)
        }.toMutableList()
        fun document() = "{\"version\":$version,\"writtenAt\":$now,\"entries\":[${stored.joinToString(",") { (k, v, at) -> "[$k,$v,$at]" }}]}"
        var text = document()
        if (text.toByteArray().size > maxBytes) {
            // The entries that have gone longest without a new value are the first to go.
            stored.sortBy { it.third }
            while (stored.isNotEmpty() && text.toByteArray().size > maxBytes) {
                stored.removeAt(0)
                text = document()
            }
        }
        written = stored.associate { (k, v, at) -> k to (v to at) }
        storage.set(storageKey, text)
    }
}

private fun JsonArray.getOrNull(index: Int): JsonElement? = if (index < size) this[index] else null
