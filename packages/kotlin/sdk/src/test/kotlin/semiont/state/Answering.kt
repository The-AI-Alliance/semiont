package semiont.state

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import semiont.channels.BRIDGED_CHANNELS
import semiont.testing.Delay
import semiont.testing.DropReply
import semiont.testing.FaultyTransport
import semiont.testing.REFUSE_UNSCRIPTED
import semiont.testing.Respond
import kotlin.coroutines.CoroutineContext

/** How the gateway behind a case's transport answers what nothing was queued for (the table's `answers`). */
internal enum class Answers {
    /** Every request is refused at once. */
    REFUSES,

    /** Every request reaches the gateway, and its reply is lost on the way: a step answers instead. */
    NEVER,

    /** A job is created and is running; anything else is refused at once. */
    JOBS,
}

/** `job:create` answered with job-1, and its status asked answered running; anything else refused by name. */
private val JOBS = Respond { operation, payload ->
    when (operation) {
        "job:create" -> JsonObject(mapOf("jobId" to JsonPrimitive("job-1")))
        "job:status-requested" -> JsonObject(
            mapOf(
                "jobId" to JsonPrimitive("job-1"),
                "type" to JsonPrimitive("mark"),
                "status" to JsonPrimitive("running"),
                "userId" to JsonPrimitive("did:web:example.org:users:alice"),
                "created" to JsonPrimitive("2026-10-01T00:00:00.000Z"),
            ),
        )
        else -> REFUSE_UNSCRIPTED.respond(operation, payload)
    }
}

/** Nothing: the reply is dropped on its way, and a step answers instead. */
private val NOBODY = Respond { _, _ -> null as JsonElement? }

/**
 * The transport a case of specs/src/client/state-units.json states, on the
 * case's clock: a `FaultyTransport` whose stream carries what a client's does,
 * the replies and the broadcasts and never the requests, answering as
 * `answers` says, `delayMs` after each request when the case says so.
 */
internal fun answering(answers: Answers, delayMs: Long?, clock: CoroutineContext): FaultyTransport = when (answers) {
    Answers.NEVER -> {
        check(delayMs == null) { "a transport that never answers holds no reply" }
        FaultyTransport(listOf(DropReply), NOBODY, BRIDGED_CHANNELS, clock)
    }
    Answers.REFUSES -> FaultyTransport(listOfNotNull(delayMs?.let(::Delay)), REFUSE_UNSCRIPTED, BRIDGED_CHANNELS, clock)
    Answers.JOBS -> FaultyTransport(listOfNotNull(delayMs?.let(::Delay)), JOBS, BRIDGED_CHANNELS, clock)
}
