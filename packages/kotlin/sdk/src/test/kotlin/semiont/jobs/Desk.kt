package semiont.jobs

import io.opentelemetry.api.trace.Span
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import semiont.bus.OPERATIONS
import semiont.testing.FaultAction
import semiont.testing.FaultyTransport
import semiont.transport.Frame
import kotlin.coroutines.CoroutineContext

internal fun obj(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(
    pairs.associate { (name, value) ->
        name to when (value) {
            null -> JsonNull
            is JsonElement -> value
            is String -> JsonPrimitive(value)
            is Number -> JsonPrimitive(value)
            is Boolean -> JsonPrimitive(value)
            else -> error("no JSON for $value")
        }
    },
)

/** A running job as the dispatcher hands one out from a claim. */
internal fun running(jobId: String, jobType: String = "mark", metadata: JsonObject = obj(), params: JsonObject = obj()): JsonObject = obj(
    "status" to "running",
    "metadata" to JsonObject(
        obj("id" to jobId, "type" to jobType, "userId" to "did:web:kb.example:users:u", "created" to "2026-01-01T00:00:00.000Z", "retryCount" to 0, "maxRetries" to 1) + metadata,
    ),
    "params" to JsonObject(obj("resourceId" to "res-1") + params),
    "startedAt" to "2026-01-01T00:00:01.000Z",
    "progress" to obj(),
)

/** An announcement of a `mark` job of `motivation`, stating less than a job of it would: it is compared as it came. */
internal fun queued(motivation: String): JsonObject =
    obj("jobId" to "job-announced", "jobType" to "mark", "resourceId" to "res-9", "userId" to "did:web:kb.example:users:u", "params" to obj("motivation" to motivation))

/** An annotation as the wire carries one: already made, with its id. */
internal fun annotation(id: String): JsonObject = obj(
    "@context" to "http://www.w3.org/ns/anno.jsonld",
    "type" to "Annotation",
    "id" to id,
    "motivation" to "highlighting",
    "target" to obj("source" to "res-1", "selector" to obj("type" to "TextQuoteSelector", "exact" to "the words of $id")),
    "created" to "2026-01-01T00:00:00.000Z",
)

/**
 * A stand-in for the dispatcher, which answers claims, and for the record,
 * which acknowledges every commit and answers every question about an
 * annotation with it, unless a test has it do otherwise: the answers of a
 * `FaultyTransport` (`transport`) whose `wire` says what happens to each
 * request's reply in turn, every reply delivered when it says nothing. Its
 * stream names `channels`, every channel when none are given. Replies come a
 * turn after the request, on `clock`.
 */
internal class Desk(clock: CoroutineContext, wire: List<FaultAction> = emptyList(), channels: Collection<String>? = null) {
    /** The jobs the dispatcher hands out, in order: none pending once they are spent. */
    val offered = ArrayDeque<JsonObject>()

    /** The failures the dispatcher answers claims with first, in order. */
    val refusals = ArrayDeque<JsonObject>()

    /** Whether the record refuses each commit. */
    var refusingCommits = false

    /** The failure the record answers a question about an annotation with, by the annotation's id. */
    val askedOf = mutableMapOf<String, JsonObject>()

    /** The trace each claim was made in, in order: its id, or none. */
    val claimedIn = mutableListOf<String?>()

    val transport = FaultyTransport(wire, ::answer, channels, clock).also { it.refuseWhen(::refusal) }

    /** A broadcast the gateway relays to this worker. */
    fun relay(channel: String, payload: JsonObject): Unit = transport.deliver(Frame(channel, payload))

    /** What was said on `channel`, in order. */
    fun sent(channel: String): List<JsonObject> = transport.emitted.filter { it.channel == channel }.map { it.payload }

    /** Everything said that is not a request: the lifecycle, in order. */
    fun said(): List<Pair<String, JsonObject>> = transport.emitted.filter { it.channel !in OPERATIONS }.map { it.channel to it.payload }

    /** Asked first of every request, as it is sent: so where a claim is made is where this runs. */
    private fun refusal(operation: String, payload: JsonObject): JsonObject? = when (operation) {
        "job:claim" -> {
            claimedIn += Span.current().spanContext.takeIf { it.isValid }?.traceId
            refusals.removeFirstOrNull() ?: if (offered.isEmpty()) obj("message" to "No pending job matches", "code" to "none-pending") else null
        }
        "mark:commit" -> if (refusingCommits) obj("message" to "the record could not append") else null
        "browse:annotation-requested" -> askedOf[payload.getValue("annotationId").jsonPrimitive.content]
        else -> null
    }

    private fun answer(operation: String, payload: JsonObject): JsonElement = when (operation) {
        "job:claim" -> offered.removeFirst()
        "mark:commit" -> {
            val ids = payload.getValue("annotations").jsonArray.map { it.jsonObject.getValue("id") }
            obj("persisted" to ids.size, "annotationIds" to JsonArray(ids))
        }
        "browse:annotation-requested" -> obj("annotation" to annotation(payload.getValue("annotationId").jsonPrimitive.content), "resource" to null, "resolvedResource" to null)
        else -> error("nothing is scripted to answer $operation")
    }
}
