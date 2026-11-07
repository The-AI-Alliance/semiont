package semiont.storage

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import semiont.cache.CachePersister
import semiont.types.wireJson
import java.math.BigDecimal
import java.util.concurrent.ConcurrentHashMap

/**
 * Where a client keeps what must outlive it: text under a key. The seam an
 * application fills in (a file, a platform's store), so nothing above it knows
 * where it runs. More than one context can write a store (two windows, two
 * processes): what is written from what was read goes through `update`, which
 * a store makes one step, so one writer's change is never lost under
 * another's; and a store that hears what another context writes says so to
 * whoever `subscribe`s.
 */
public interface SessionStorage {
    /** What is stored under `key`, when anything is. */
    public fun get(key: String): String?

    /** Store `value` under `key`, in place of what was there. */
    public fun set(key: String, value: String)

    /** Remove `key`. One that is not there is left not there. */
    public fun delete(key: String)

    /**
     * Change `key`'s value as one step: `change` is given what is stored,
     * null when nothing is, and says what is stored next, null for nothing.
     * No other writer's change falls between the read and the write.
     */
    public fun update(key: String, change: (String?) -> String?)

    /**
     * Hear what another context writes: another process, another window.
     * `onChange` is given the key, and the value written, or null when the
     * key was removed; closing the answer ends the subscription. Null where
     * the environment has no other context: a client then works correctly
     * within its own.
     */
    public fun subscribe(onChange: (key: String, value: String?) -> Unit): AutoCloseable?
}

/** A `SessionStorage` kept in memory, for as long as the process lives: a client that closes and one that opens after it, over the same storage, are a reload. No other context writes it. */
public class MemoryStorage : SessionStorage {
    private val stored = ConcurrentHashMap<String, String>()

    override fun get(key: String): String? = stored[key]

    override fun set(key: String, value: String) {
        stored[key] = value
    }

    override fun delete(key: String) {
        stored.remove(key)
    }

    override fun update(key: String, change: (String?) -> String?) {
        stored.compute(key) { _, before -> change(before) }
    }

    override fun subscribe(onChange: (key: String, value: String?) -> Unit): AutoCloseable? = null
}

/**
 * Where a client keeps what its queries hold for one person, so the next
 * client of the same knowledge base for them, in any SDK, shows it at once:
 * one document for each query it keeps, in `storage`, under
 * `semiont.cache.<kbId>.<personKey>.<query>`, the query named as
 * client/refresh.json names it. `personKey` is `semiont.registry.personKey` of
 * the did the gateway said the client's token is.
 */
public class CachePersistence(public val storage: SessionStorage, public val kbId: String, public val personKey: String)

/**
 * A cache's values in `storage`, under `storageKey`, as one document,
 * session/stored.json's `cacheDocument`: `{version, entries}`, each entry a
 * key, its value, and when that value was received, in milliseconds since the
 * epoch. `key` and `value` say how each is read and written, `version` which
 * documents are this cache's to read, and `maxBytes` how large the document
 * may be. A document that is not one of this version (no JSON, no object,
 * `entries` no list, or an entry not a key, a value and a whole number of at
 * least 0) reads as nothing kept; an entry whose key or value is not this
 * cache's is skipped, and the rest are kept. A document larger than it may be
 * loses the entries received longest ago, until it fits.
 */
public class StoragePersister<K : Any, V : Any>(
    private val storage: SessionStorage,
    private val storageKey: String,
    private val key: KSerializer<K>,
    private val value: KSerializer<V>,
    private val version: Long,
    private val maxBytes: Long,
) : CachePersister<K, V> {
    /** Each key's value as last written, and when it was received: a value received again unchanged keeps its time. */
    private var written = mapOf<String, Pair<String, BigDecimal>>()

    override fun load(): Map<K, V>? {
        val entries = entriesOf(storage.get(storageKey) ?: return null) ?: return null
        val kept = LinkedHashMap<K, V>()
        val received = LinkedHashMap<String, Pair<String, BigDecimal>>()
        for ((stated, at) in entries) {
            try {
                kept[wireJson.decodeFromJsonElement(key, stated[0])] = wireJson.decodeFromJsonElement(value, stated[1])
            } catch (_: IllegalArgumentException) {
                continue
            }
            received[stated[0].toString()] = stated[1].toString() to at
        }
        written = received
        return kept
    }

    /**
     * The entries of `text`, each with its stamp, when it is a document of this
     * version; null when it is not one. A number is its value, however it is
     * written: a whole number is one with no fractional part.
     */
    private fun entriesOf(text: String): List<Pair<JsonArray, BigDecimal>>? {
        val document = try {
            wireJson.parseToJsonElement(text)
        } catch (_: SerializationException) {
            return null
        }
        if (document !is JsonObject) return null
        val stated = document["version"]?.let(::numberOf)
        val entries = document["entries"] as? JsonArray
        if (stated == null || stated.compareTo(BigDecimal.valueOf(version)) != 0 || entries == null) return null
        return entries.map { entry ->
            if (entry !is JsonArray || entry.size != 3) return null
            val at = numberOf(entry[2])?.stripTrailingZeros()
            if (at == null || at.scale() > 0 || at.signum() < 0) return null
            entry to at
        }
    }

    override fun save(entries: Map<K, V>) {
        val now = BigDecimal.valueOf(System.currentTimeMillis())
        val stored = entries.map { (k, v) ->
            val keyText = wireJson.encodeToJsonElement(key, k).toString()
            val valueText = wireJson.encodeToJsonElement(value, v).toString()
            val before = written[keyText]
            Triple(keyText, valueText, if (before != null && before.first == valueText) before.second else now)
        }.toMutableList()
        fun document() = "{\"version\":$version,\"entries\":[${stored.joinToString(",") { (k, v, at) -> "[$k,$v,${at.toPlainString()}]" }}]}"
        var text = document()
        if (text.toByteArray().size > maxBytes) {
            // The entries received longest ago are the first to go.
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

/** The number `element` is, by its value; none for a text, a boolean or null. */
private fun numberOf(element: JsonElement): BigDecimal? = (element as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toBigDecimalOrNull()
