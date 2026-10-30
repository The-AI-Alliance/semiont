package semiont.bus

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import semiont.identifiers.ResourceId
import semiont.telemetry.Telemetry

/** What a line says in place of a credential. */
private const val WITHHELD = "[withheld]"

/** What a line of the bus log is about: a frame sent or received, or a read or upload of content. */
internal enum class Logged { EMIT, RECV, PUT, GET }

/**
 * The bus log: with `SEMIONT_BUS_LOG` set to anything but nothing, a line on
 * standard output for each frame a transport sends or receives, each read
 * and each upload.
 *
 *     [bus EMIT] mark:create-request scope=res-1 cid=a89a670a trace=8f3ca4ed {"resourceId":"res-1"}
 *
 * Every Semiont SDK writes it in one form, so that the lines of several
 * processes read as one timeline (docs/protocol/EVENT-BUS.md, Wire format).
 * A line is written when what it says is done: the frame's channel, or
 * `content` for a read or an upload; the resource's scope, the first eight
 * characters of the correlation id, and the first eight of the id of the
 * trace it was written in, each where there is one; and the payload, as
 * JSON, every credential's value withheld. The variable is read once, when
 * the first line would be written: it is the one environment variable this
 * SDK reads.
 */
internal object BusLog {
    private val enabled: Boolean by lazy { !System.getenv("SEMIONT_BUS_LOG").isNullOrEmpty() }

    /** Write the line of one frame sent or received, or of one read or upload of content. */
    fun line(op: Logged, channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?) {
        if (enabled) say(busLine(op, channel, payload, scope, correlationId, Telemetry.headers()["traceparent"]))
    }

    /** Write a line about a channel that is no frame: `[bus <op>] <channel> <note>`. */
    fun note(op: String, channel: String, note: String) {
        if (enabled) say("[bus $op] $channel $note")
    }

    private fun say(line: String) {
        synchronized(System.out) {
            println(line)
            System.out.flush()
        }
    }
}

/** The line of one frame or content operation, written in the trace `traceparent` names. */
internal fun busLine(op: Logged, channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?, traceparent: String?): String =
    buildString {
        append("[bus ${op.name}] $channel")
        scope?.let { append(" scope=${it.value}") }
        correlationId?.takeIf { it.isNotEmpty() }?.let { append(" cid=${it.take(8)}") }
        // A trace context's second field is the trace's id.
        traceparent?.split('-')?.getOrNull(1)?.let { append(" trace=${it.take(8)}") }
        append(' ')
        append(shown(payload))
    }

/** A payload as a line shows it: as it is, less the value of each credential, wherever in it the credential is. */
internal fun shown(value: JsonElement): JsonElement = when (value) {
    is JsonObject -> JsonObject(value.mapValues { (name, member) -> if (name in CREDENTIAL_NAMES) JsonPrimitive(WITHHELD) else shown(member) })
    is JsonArray -> JsonArray(value.map(::shown))
    else -> value
}
