package semiont.discovery

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import semiont.Timings
import semiont.telemetry.futureOf
import semiont.transport.Events
import semiont.types.DiscoveredKB
import semiont.types.DiscoveryDocument
import semiont.types.wireJson
import java.io.FileNotFoundException
import java.io.IOException
import java.nio.file.NoSuchFileException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.atomic.AtomicBoolean

// The knowledge bases a launcher manages, as the launcher publishes them (specs/src/discovery): what the
// document says, read whole or not at all, and what changed since it was last read.

/** How often a launcher's document is read again, in milliseconds, unless a caller says otherwise. */
public const val DISCOVERY_INTERVAL: Long = Timings.DISCOVERY_INTERVAL_MS

/** The version of the document this client reads. */
private const val VERSION = 1L

/** Why no launcher was found, as specs/src/client/discovery-absent.json states each reason. */
public enum class DiscoveryAbsentReason(
    /** The reason as every SDK spells it. */
    public val wire: String,
) {
    /** There is no document where it was looked for. */
    NotFound("not-found"),

    /** There is a document, and it is not JSON. */
    NotJson("not-json"),

    /** It is JSON, and not a discovery document. */
    Invalid("invalid"),

    /** It is of a version this client does not speak, and is not read in part. */
    UnsupportedVersion("unsupported-version"),

    /** It could not be read at all. */
    Unreadable("unreadable"),
}

/** What one read gave: a state, or that nothing changed since the last. */
public sealed interface DiscoveryRead

/**
 * What a launcher's document says. Absent is not empty: `Absent` is "no
 * launcher was found", with why; `Managed` with no knowledge bases is "the
 * launcher is here and manages nothing".
 */
public sealed interface DiscoveryState : DiscoveryRead

/** No launcher was found, and why. `diagnostic` is what was wrong, in words; null when there is no more to say. */
public data class Absent @JvmOverloads constructor(public val reason: DiscoveryAbsentReason, public val diagnostic: String? = null) : DiscoveryState

/** The knowledge bases a launcher manages: none is a launcher that manages nothing. */
public data class Managed(public val kbs: List<DiscoveredKB>) : DiscoveryState

/** A read that found nothing changed since the last. */
public data object Unchanged : DiscoveryRead

/** Where the document is read from. */
public interface DiscoveryTransport {
    /** Read the document once. */
    public suspend fun read(): DiscoveryRead

    /** `read`, for Java. */
    public fun readFuture(): CompletableFuture<DiscoveryRead> = CoroutineScope(Dispatchers.Default).futureOf { read() }
}

/**
 * The document's text as a state. Every reader goes through this. A document
 * is read whole: one of a version this client does not speak, or with an entry
 * that is not what the schema says, is absent, since a partial reading would
 * hide a running knowledge base without a trace.
 */
public fun parseDiscoveryDocument(text: String): DiscoveryState {
    val parsed = try {
        wireJson.parseToJsonElement(text)
    } catch (notJson: IllegalArgumentException) {
        return Absent(DiscoveryAbsentReason.NotJson, notJson.message ?: "the document is not JSON")
    }
    val document = parsed as? JsonObject ?: return Absent(DiscoveryAbsentReason.Invalid, "document is not an object")
    val version = (document["version"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
        ?: return Absent(DiscoveryAbsentReason.Invalid, "missing numeric \"version\"")
    if (version != VERSION) {
        return Absent(
            DiscoveryAbsentReason.UnsupportedVersion,
            "discovery document version $version is not the one this client speaks ($VERSION); it is not read in part",
        )
    }
    // Strictly: a port written as text is not the schema's, though a reader of numbers would take it.
    (document["kbs"] as? JsonArray)?.forEachIndexed { at, entry ->
        val port = (entry as? JsonObject)?.get("port")
        if (port is JsonPrimitive && port.isString) return Absent(DiscoveryAbsentReason.Invalid, "kbs[$at].port: a port is a number, not text")
    }
    val read = try {
        wireJson.decodeFromJsonElement(DiscoveryDocument.serializer(), document)
    } catch (invalid: IllegalArgumentException) {
        return Absent(DiscoveryAbsentReason.Invalid, invalid.message ?: "not a discovery document")
    }
    read.kbs.firstOrNull { it.port !in 1..65535 }?.let { return Absent(DiscoveryAbsentReason.Invalid, "kb entry at ${it.host} has port ${it.port}, which is not a port") }
    return Managed(read.kbs)
}

/**
 * A transport over any way of getting the document's text. `readText` gives
 * the text, and throws `NoSuchFileException` or `FileNotFoundException` when
 * there is no document, and another `IOException` when it could not be read,
 * as reading the launcher's file with `java.nio.file.Files.readString` does.
 * It is called off the caller's thread.
 */
public fun textDiscovery(readText: () -> String): DiscoveryTransport = object : DiscoveryTransport {
    override suspend fun read(): DiscoveryRead {
        val text = try {
            withContext(Dispatchers.IO) { readText() }
        } catch (_: NoSuchFileException) {
            return Absent(DiscoveryAbsentReason.NotFound)
        } catch (_: FileNotFoundException) {
            return Absent(DiscoveryAbsentReason.NotFound)
        } catch (unread: IOException) {
            return Absent(DiscoveryAbsentReason.Unreadable, unread.message ?: unread::class.java.simpleName)
        }
        return parseDiscoveryDocument(text)
    }
}

/**
 * What one read changed: the state now, and what was added, changed and
 * removed since the last one told of. Entries are told apart by address (host
 * and port), which the launcher keeps unique; a did is not unique, one
 * knowledge base running in two places being two entries with one did.
 * `duplicated` names the addresses more than one entry claims, each once: at
 * most one claim can be true, and every claimant is in `state`.
 */
public data class DiscoveryDiff(
    public val state: DiscoveryState,
    public val added: List<DiscoveredKB>,
    public val updated: List<DiscoveredKB>,
    public val removed: List<DiscoveredKB>,
    public val duplicated: List<String>,
)

private fun addressOf(kb: DiscoveredKB) = "${kb.host}:${kb.port}"

/** The knowledge bases a state lists: none when it is absent, or when there is no state. */
private fun kbsOf(state: DiscoveryState?): List<DiscoveredKB> = (state as? Managed)?.kbs.orEmpty()

/** What changed between `last`, the state last told of (null when none was), and `now`; null when nothing did. */
private fun diffOf(last: DiscoveryState?, now: DiscoveryState): DiscoveryDiff? {
    val before = kbsOf(last).associateBy(::addressOf)
    val after = kbsOf(now).map(::addressOf).toSet()
    val added = mutableListOf<DiscoveredKB>()
    val updated = mutableListOf<DiscoveredKB>()
    val duplicated = mutableListOf<String>()
    val claimed = mutableMapOf<String, Int>()
    for (kb in kbsOf(now)) {
        val at = addressOf(kb)
        val claims = claimed.getOrDefault(at, 0) + 1
        claimed[at] = claims
        if (claims == 2) duplicated += at
        val was = before[at]
        if (was == null) added += kb else if (was != kb) updated += kb
    }
    val removed = kbsOf(last).filter { addressOf(it) !in after }
    val stateChanged = when {
        last is Managed && now is Managed -> false
        last is Absent && now is Absent -> last.reason != now.reason
        else -> true
    }
    if (!stateChanged && added.isEmpty() && updated.isEmpty() && removed.isEmpty()) return null
    return DiscoveryDiff(now, added, updated, removed, duplicated)
}

/**
 * Read a launcher's document now and then every `intervalMs`, and tell of each
 * change. The first read is always told of. After it, a read that changed
 * nothing is not: only an entry added, changed or removed, and a change of
 * state, which carries every entry it brought or took away. It reads only
 * while it is collected, by one collector, once; closing it reads no more.
 */
public fun subscribeDiscovery(transport: DiscoveryTransport, intervalMs: Long): Events<DiscoveryDiff> {
    val closed = AtomicBoolean(false)
    val reading = flow {
        var last: DiscoveryState? = null
        while (!closed.get()) {
            val read = transport.read()
            if (read is DiscoveryState) {
                diffOf(last, read)?.let { change ->
                    last = change.state
                    emit(change)
                }
            }
            delay(intervalMs)
        }
    }
    return Events(reading) { closed.set(true) }
}
