package semiont.namespaces

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.ClientTiming
import semiont.Delegation
import semiont.JobAttemptFailed
import semiont.JobCompleted
import semiont.JobCreated
import semiont.JobEvent
import semiont.JobProgressed
import semiont.Recording
import semiont.Running
import semiont.SemiontClient
import semiont.Timings
import semiont.errors.BusRequestError
import semiont.errors.JobError
import semiont.errors.SemiontError
import semiont.errors.TransportError
import semiont.identifiers.JobId
import semiont.identifiers.ResourceId
import semiont.transport.Broadcast
import semiont.transport.ConnectionState
import semiont.transport.Events
import semiont.transport.Frame
import semiont.transport.FrameSink
import semiont.transport.PendingReply
import semiont.transport.ReplyRouter
import semiont.transport.ResourceHold
import semiont.transport.Transport
import semiont.transport.Watched
import semiont.types.CommentingJobParams
import semiont.types.GenerationJobParams
import semiont.types.HighlightingJobParams
import semiont.types.JobCompleteCommand
import semiont.types.JobDeclined
import semiont.types.JobProgress
import semiont.types.MarkJobCompleteCommand
import semiont.types.MarkJobDone
import semiont.types.YieldJobCompleteCommand
import semiont.types.YieldJobDone
import semiont.types.wireJson
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList

private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

private val RESOURCE = ResourceId("res-1")

private val CONTEXT = json(
    """{"focus":{"kind":"resource","resource":{"@context":"https://schema.org","@id":"res-1","name":"A resource","representations":[]}},"graph":{"nodes":[],"edges":[]},"metadata":{}}""",
)

private val GENERATED = json("""{"resourceId":"res-summary","resourceName":"A summary","truncated":false}""")

/** What reached the queue: on which channel, with what, and when, in milliseconds of the monotonic clock. */
private data class Asked(val channel: String, val payload: JsonObject, val correlationId: String?, val atMs: Long)

/**
 * A knowledge base's queue as a follower meets it. It answers a job's
 * creation with the job ids it is given, one each, and with nothing once they
 * are spent; and a status request with the statuses it is given, one each,
 * and with a refusal once they are spent. It keeps what was asked of it.
 */
private class Queue(createdIds: List<String>) : Transport {
    val asked = CopyOnWriteArrayList<Asked>()
    private val created = ArrayDeque(createdIds)
    private val statuses = ArrayDeque<JsonObject>()
    var refusesCreation = false
    private val router = ReplyRouter()
    private val now = MutableStateFlow(ConnectionState.Open)

    fun statuses(vararg answers: JsonObject) = synchronized(statuses) { statuses.addAll(answers) }

    fun asked(channel: String): List<Asked> = asked.filter { it.channel == channel }

    fun reply(channel: String, payload: JsonObject, correlationId: String?) = router.route(Frame(channel, payload, correlationId))

    override val baseUrl: String = "http://kb.test"
    override val state: Watched<ConnectionState> = Watched(now) { it == ConnectionState.Closed }

    override suspend fun emit(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): Long? {
        asked += Asked(channel, payload, correlationId, System.nanoTime() / 1_000_000)
        when (channel) {
            "job:create" -> when {
                refusesCreation -> reply("job:create-failed", json("""{"message":"the queue is full"}"""), correlationId)
                else -> synchronized(created) { created.removeFirstOrNull() }?.let { reply("job:created", json("""{"response":{"jobId":"$it"}}"""), correlationId) }
            }
            "job:status-requested" -> {
                val status = synchronized(statuses) { statuses.removeFirstOrNull() }
                if (status != null) {
                    reply("job:status-result", JsonObject(mapOf("response" to status)), correlationId)
                } else {
                    reply("job:status-failed", json("""{"message":"no status"}"""), correlationId)
                }
            }
        }
        return 1
    }

    override fun emitFuture(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): CompletableFuture<Long?> =
        throw UnsupportedOperationException("the client emits by its own future")

    override fun frames(channel: String): Events<Frame> = Broadcast<Frame>().listen()

    override fun isSubscribed(channel: String): Boolean = true

    override fun subscribeToResource(resourceId: ResourceId): ResourceHold = ResourceHold {}

    override fun failures(): Events<SemiontError> = Broadcast<SemiontError>().listen()

    override fun bridgeInto(bus: FrameSink) = Unit

    override fun trackReply(correlationId: String, replyChannels: Collection<String>): PendingReply = router.track(correlationId, replyChannels)

    override fun close() {
        now.value = ConnectionState.Closed
        router.close()
    }
}

/** A client whose queue names its jobs `ids`, in turn, and waits as `timing` says. */
private fun world(vararg ids: String, timing: ClientTiming = ClientTiming()): Pair<SemiontClient, Queue> {
    val queue = Queue(ids.toList())
    val recording = Recording()
    return SemiontClient(queue, recording, recording, timing) to queue
}

private fun SemiontClient.highlighting(): Delegation<MarkJobCompleteCommand> = mark.delegate(RESOURCE, HighlightingJobParams())

private fun SemiontClient.generation(stallDeadlineMs: Long?): Delegation<YieldJobCompleteCommand> {
    val params = wireJson.decodeFromJsonElement(
        GenerationJobParams.serializer(),
        JsonObject(mapOf("title" to JsonPrimitive("A summary"), "storageUri" to JsonPrimitive("file://a-summary.md"), "context" to CONTEXT)),
    )
    return yield.delegate(params, stallDeadlineMs)
}

/** A frame of the lifecycle of the job `jobId`, which is `of` that type. */
private fun SemiontClient.say(channel: String, jobId: String, of: String = "mark", vararg more: Pair<String, JsonElement>) {
    val stated = mapOf("resourceId" to JsonPrimitive("res-1"), "jobId" to JsonPrimitive(jobId), "jobType" to JsonPrimitive(of)) + more
    bus.emit(channel, JsonObject(stated), null, null)
}

private fun progress(percentage: Int): Array<Pair<String, JsonElement>> =
    arrayOf("percentage" to JsonPrimitive(percentage), "progress" to JsonObject(mapOf("percentage" to JsonPrimitive(percentage))))

private fun status(of: String, vararg more: Pair<String, JsonElement>): JsonObject = JsonObject(
    mapOf(
        "jobId" to JsonPrimitive("job-1"),
        "type" to JsonPrimitive("mark"),
        "status" to JsonPrimitive(of),
        "userId" to JsonPrimitive("did:web:example.org:users:alice"),
        "created" to JsonPrimitive("2026-10-01T00:00:00.000Z"),
    ) + more,
)

private fun <C : JobCompleteCommand> kind(event: JobEvent<C>): String = when (event) {
    is JobCreated -> "created ${event.data.jobId.value}"
    is JobProgressed -> "progress ${event.data.percentage.toInt()}"
    is JobAttemptFailed -> "failed"
    is JobCompleted -> "complete"
}

/** Everything a follower gives, as words: each event's kind, and the code of the failure that ended it. */
private class Following<C : JobCompleteCommand>(delegation: Delegation<C>, scope: CoroutineScope) {
    val seen = CopyOnWriteArrayList<JobEvent<C>>()
    val words: Deferred<List<String>> = scope.async {
        val kinds = mutableListOf<String>()
        try {
            delegation.collect {
                seen += it
                kinds += kind(it)
            }
        } catch (error: SemiontError) {
            kinds += "error ${error.code}"
        }
        kinds
    }
}

private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

private fun <C : JobCompleteCommand> following(delegation: Delegation<C>) = Following(delegation, scope)

private fun <C : JobCompleteCommand> awaiting(delegation: Delegation<C>): Deferred<C> = scope.async { delegation.await() }

private suspend fun <T> soon(work: Deferred<T>): T = withTimeout(5_000) { work.await() }

/** Wait until the queue has been asked on `channel` `times` times. */
private suspend fun Queue.until(channel: String, times: Int = 1) = withTimeout(5_000) {
    while (asked(channel).size < times) delay(5)
}

private suspend fun <T> failedWith(work: Deferred<T>): Throwable = withTimeout(5_000) {
    try {
        work.await()
        error("it did not fail")
    } catch (failure: SemiontError) {
        failure
    }
}

/** Following a job (docs/protocol/JOBS.md, Following a job), through the two methods that create one: `mark.delegate` and `yield.delegate`. */
class FollowTest {
    @Test
    fun aJobReportsItsProgressAndEndsWithItsCompletion() = runBlocking {
        val (client, queue) = world("job-1")
        val read = following(client.highlighting())
        queue.until("job:create")
        assertEquals(listOf(json("""{"jobType":"mark","resourceId":"res-1","params":{"motivation":"highlighting"}}""")), queue.asked.map { it.payload })
        client.say("job:report-progress", "job-1", "mark", *progress(10))
        // Another job's frames are not this follower's.
        client.say("job:report-progress", "job-2", "mark", *progress(99))
        client.say("job:complete", "job-2")
        client.say("job:report-progress", "job-1", "mark", *progress(60))
        // Progress that states nothing of how far the job is reports nothing.
        client.say("job:report-progress", "job-1", "mark", "percentage" to JsonPrimitive(70))
        client.say("job:complete", "job-1", "mark", "result" to json("""{"found":3,"persisted":2,"errors":1}"""))
        assertEquals(listOf("created job-1", "progress 10", "progress 60", "complete"), soon(read.words))
        // Its completion is the last of its events.
        val last = assertInstanceOf(JobCompleted::class.java, read.seen.last())
        val done = assertInstanceOf(MarkJobCompleteCommand::class.java, last.data)
        assertEquals(Triple("complete", JobId("job-1"), RESOURCE), Triple(last.kind, done.jobId, done.resourceId))
        assertEquals(MarkJobDone(found = 3, persisted = 2, errors = 1), done.result)
        assertEquals(emptyList<Asked>(), queue.asked("job:status-requested"))
        client.close()
    }

    @Test
    fun aJobIsNamedBeforeAnythingElseOfItIsGiven() = runBlocking {
        val (client, queue) = world("job-1")
        val read = following(client.highlighting())
        queue.until("job:create")
        client.say("job:complete", "job-1")
        assertEquals("created job-1", soon(read.words).first())
        val first = assertInstanceOf(JobCreated::class.java, read.seen.first())
        assertEquals("created", first.kind)
        assertEquals(json("""{"jobId":"job-1"}"""), wireJson.encodeToJsonElement(semiont.types.JobCreatedResultResponse.serializer(), first.data))
        client.close()
    }

    @Test
    fun awaitedAJobGivesItsCompletion() = runBlocking {
        val (client, queue) = world("job-1")
        val awaited = awaiting(client.highlighting())
        queue.until("job:create")
        client.say("job:report-progress", "job-1", "mark", *progress(10))
        client.say("job:complete", "job-1", "mark", "result" to json("""{"found":2,"persisted":2}"""))
        // The completion itself, and no event to take it out of: a mark job's, whose result is what a mark job reports.
        val done = soon(awaited)
        assertEquals(Triple(JobId("job-1"), "mark", RESOURCE), Triple(done.jobId, done.jobType.value, done.resourceId))
        assertEquals(MarkJobDone(found = 2, persisted = 2), done.result)
        client.close()
    }

    @Test
    fun whatAMarkJobReportsIsItsCountsOrADecline() = runBlocking {
        suspend fun reported(result: String): MarkJobCompleteCommand {
            val (client, queue) = world("job-1")
            val awaited = awaiting(client.highlighting())
            queue.until("job:create")
            client.say("job:complete", "job-1", "mark", "result" to json(result))
            return soon(awaited).also { client.close() }
        }
        assertEquals(MarkJobDone(found = 4, persisted = 3), reported("""{"found":4,"persisted":3}""").result)
        assertInstanceOf(JobDeclined::class.java, reported("""{"declined":true,"reason":"encrypted"}""").result)
        Unit
    }

    @Test
    fun awaitedAGenerationGivesTheResourceItMade() = runBlocking {
        val (client, queue) = world("job-1")
        val awaited = awaiting(client.generation(null))
        queue.until("job:create")
        client.say("job:complete", "job-1", "yield", "result" to GENERATED)
        val done = soon(awaited)
        assertEquals("yield", done.jobType.value)
        assertEquals(YieldJobDone(resourceId = ResourceId("res-summary"), resourceName = "A summary", truncated = false), done.result)
        client.close()
    }

    @Test
    fun aDelegationIsAwaitedOrReadAndOnce() = runBlocking {
        val (client, queue) = world("job-1", "job-1")
        val read = client.highlighting()
        val words = following(read).words
        queue.until("job:create")
        client.say("job:complete", "job-1")
        assertEquals(listOf("created job-1", "complete"), soon(words))
        assertThrows(IllegalStateException::class.java) { runBlocking { read.await() } }
        assertThrows(IllegalStateException::class.java) { runBlocking { read.collect {} } }

        val awaited = client.highlighting()
        val done = awaiting(awaited)
        queue.until("job:create", 2)
        assertThrows(IllegalStateException::class.java) { runBlocking { awaited.collect {} } }
        client.say("job:complete", "job-1")
        soon(done)
        // Each was one job, created once.
        assertEquals(2, queue.asked("job:create").size)
        client.close()
    }

    @Test
    fun aFollowerThatEndsOnAnythingButACompletionIsNoCompletion() = runBlocking {
        val ended = Delegation<MarkJobCompleteCommand>(Running(scope) { JobProgressed(JobProgress(percentage = 50.0)) })
        val failure = assertThrows(IllegalStateException::class.java) { runBlocking { ended.await() } }
        assertEquals("a delegated job ended on a progress event, not on its completion", failure.message)
        Unit
    }

    @Test
    fun nothingIsSentUntilADelegationIsAwaitedOrRead() = runBlocking {
        val (client, queue) = world("job-1")
        client.highlighting()
        delay(100)
        assertEquals(emptyList<Asked>(), queue.asked.toList())
        client.close()
    }

    @Test
    fun framesThatArriveBeforeTheJobsIdIsKnownAreKeptAndHandledInTheOrderTheyCame() = runBlocking {
        val (client, queue) = world()
        val read = following(client.highlighting())
        queue.until("job:create")
        val created = queue.asked("job:create").single()
        client.say("job:report-progress", "job-1", "mark", *progress(10))
        client.say("job:report-progress", "job-2", "mark", *progress(99))
        client.say("job:complete", "job-1")
        delay(100)
        assertFalse(read.words.isCompleted)
        queue.reply("job:created", json("""{"response":{"jobId":"job-1"}}"""), created.correlationId)
        assertEquals(listOf("created job-1", "progress 10", "complete"), soon(read.words))
        client.close()
    }

    @Test
    fun aSilentJobIsAskedForItsStatusUntilItsStatusIsAnEnd() = runBlocking {
        val (client, queue) = world("job-1", timing = ClientTiming(jobSilenceMs = SILENCE, jobStatusPollMs = POLL))
        queue.statuses(status("running"), status("complete"))
        val read = following(client.highlighting())
        queue.until("job:create")
        assertEquals(listOf("created job-1", "complete"), soon(read.words))
        val asks = queue.asked("job:status-requested")
        assertEquals(listOf(json("""{"jobId":"job-1"}"""), json("""{"jobId":"job-1"}""")), asks.map { it.payload })
        // The first ask comes once the job has been silent for a while, and the second a poll after it, and not before.
        val created = queue.asked("job:create").single().atMs
        assertTrue(asks[0].atMs - created >= SILENCE - SLACK, "asked ${asks[0].atMs - created}ms after the job's creation")
        assertTrue(asks[1].atMs - asks[0].atMs >= POLL - SLACK, "asked again ${asks[1].atMs - asks[0].atMs}ms after")

        // What the stream did not carry, from the status: which says what the job was, and the follower knows what it was about.
        val done = assertInstanceOf(MarkJobCompleteCommand::class.java, assertInstanceOf(JobCompleted::class.java, read.seen[1]).data)
        assertEquals(listOf(JobId("job-1"), RESOURCE, "mark", null), listOf(done.jobId, done.resourceId, done.jobType.value, done.result))
        client.close()
    }

    @Test
    fun aStatusCarriesTheResultItsJobWasStoredWithAndAnEmptyOneIsNone() = runBlocking {
        suspend fun learned(result: String): MarkJobCompleteCommand {
            val (client, queue) = world("job-1", timing = QUICK)
            queue.statuses(status("complete", "result" to json(result)))
            return soon(awaiting(client.highlighting())).also { client.close() }
        }
        assertEquals(MarkJobDone(found = 3, persisted = 2), learned("""{"found":3,"persisted":2}""").result)
        assertNull(learned("{}").result)
    }

    @Test
    fun aCompletionHeardThatIsAnotherVerbsEndsTheFollowerAndIsNoFailureOfTheJob() = runBlocking {
        val (client, queue) = world("job-1")
        val awaited = awaiting(client.highlighting())
        queue.until("job:create")
        // The job that was delegated is a mark job, and this says a yield job completed.
        client.say("job:complete", "job-1", "yield", "result" to GENERATED)
        val ended = assertInstanceOf(TransportError::class.java, failedWith(awaited))
        assertEquals("The job:complete of job job-1 is a yield job's, and the job delegated is a mark job", ended.message)
        assertEquals("error", ended.code)
        assertEquals(emptyList<Asked>(), queue.asked("job:cancel-requested"))
        client.close()
    }

    @TestFactory
    fun aStatusWhoseCompletionIsNotTheVerbsEndsTheFollowerAndIsNoFailureOfTheJob(): List<DynamicTest> = listOf(
        Triple("a mark job, and the status is a yield job's", "mark", arrayOf<Pair<String, JsonElement>>("type" to JsonPrimitive("yield"))),
        Triple("a mark job, and the status is a yield job's with its result", "mark", arrayOf("type" to JsonPrimitive("yield"), "result" to GENERATED)),
        Triple("a mark job, and the result is a generation's", "mark", arrayOf<Pair<String, JsonElement>>("result" to GENERATED)),
        Triple("a yield job, and the status is a mark job's", "yield", arrayOf<Pair<String, JsonElement>>("type" to JsonPrimitive("mark"))),
        Triple("a yield job, and the result is a mark job's counts", "yield", arrayOf("type" to JsonPrimitive("yield"), "result" to json("""{"found":3,"persisted":2}"""))),
    ).map { (why, delegated, said) ->
        DynamicTest.dynamicTest(why) {
            runBlocking {
                val (client, queue) = world("job-1", timing = QUICK)
                queue.statuses(status("complete", *said))
                val words = if (delegated == "mark") following(client.highlighting()).words else following(client.generation(null)).words
                // What the knowledge base answered is not the protocol's: no completion is made of it, and the job is not said to have failed.
                assertEquals(listOf("created job-1", "error error"), soon(words))
                client.close()
            }
        }
    }

    @Test
    fun aStatusWhoseCompletionIsNotTheVerbsIsToldWithoutWhatItHolds() = runBlocking {
        val carried = "a-name-nobody-prints"
        val (client, queue) = world("job-1", timing = QUICK)
        queue.statuses(status("complete", "result" to JsonObject(GENERATED + ("resourceName" to JsonPrimitive(carried)))))
        val ended = assertInstanceOf(TransportError::class.java, failedWith(awaiting(client.highlighting())))
        assertTrue(ended.message!!.startsWith("The status of job job-1 is not a completed mark job's"), ended.message)
        assertFalse(ended.stackTraceToString().contains(carried), "the failure prints what the job made")
        assertEquals("error", ended.code)
        client.close()
    }

    @Test
    fun everyFrameOfTheJobStartsTheSilenceAgain() = runBlocking {
        val (client, queue) = world("job-1", timing = ClientTiming(jobSilenceMs = SILENCE, jobStatusPollMs = POLL))
        val read = following(client.highlighting())
        queue.until("job:create")
        delay(SILENCE * 2 / 3)
        client.say("job:report-progress", "job-1", "mark", *progress(10))
        delay(SILENCE * 2 / 3)
        assertEquals(emptyList<Asked>(), queue.asked("job:status-requested"))
        queue.until("job:status-requested")
        // A status that could not be had is asked for again at the next poll.
        queue.until("job:status-requested", 2)
        assertFalse(read.words.isCompleted)
        client.close()
        assertEquals(listOf("created job-1", "progress 10", "error bus.closed"), soon(read.words))
    }

    @TestFactory
    fun aStatusThatIsAnEndAndNoCompletionEndsTheFollowerWithIt(): List<DynamicTest> = listOf(
        listOf("failed", "the worker gave up", "job.failed", "the worker gave up"),
        listOf("failed", null, "job.failed", "Job failed"),
        // Nothing announces a cancellation: this is where its follower learns of one.
        listOf("cancelled", null, "job.cancelled", "The job was cancelled"),
    ).map { (of, error, code, message) ->
        DynamicTest.dynamicTest("$of${if (error == null) ", with no word why" else ""}") {
            runBlocking {
                val (client, queue) = world("job-1", timing = QUICK)
                queue.statuses(if (error == null) status(of!!) else status(of!!, "error" to JsonPrimitive(error)))
                val ended = assertInstanceOf(JobError::class.java, failedWith(awaiting(client.highlighting())))
                assertEquals(listOf(code, message, JobId("job-1")), listOf(ended.code, ended.message, ended.jobId))
                client.close()
            }
        }
    }

    @Test
    fun aFailureTheQueueWillRetryIsReportedAndFollowedPast() = runBlocking {
        val (client, queue) = world("job-1", timing = ClientTiming(jobSilenceMs = SILENCE, jobStatusPollMs = POLL))
        val read = following(client.highlighting())
        queue.until("job:create")
        client.say("job:fail", "job-1", "mark", "error" to JsonPrimitive("a blip"), "willRetry" to JsonPrimitive(true))
        // The attempt that died is not asked about, however long the next takes.
        delay(SILENCE * 3)
        assertEquals(emptyList<Asked>(), queue.asked("job:status-requested"))
        client.say("job:report-progress", "job-1", "mark", *progress(60))
        client.say("job:complete", "job-1")
        assertEquals(listOf("created job-1", "failed", "progress 60", "complete"), soon(read.words))
        val setback = assertInstanceOf(JobAttemptFailed::class.java, read.seen[1])
        assertEquals("failed" to "a blip", setback.kind to setback.data.error)
        client.close()
    }

    @TestFactory
    fun aFailureThatIsFinalEndsTheFollowerAndOneThatDoesNotSayIsFinal(): List<DynamicTest> = listOf(
        "it says it will not be tried again" to arrayOf<Pair<String, JsonElement>>("willRetry" to JsonPrimitive(false)),
        "it does not say" to emptyArray(),
    ).map { (why, said) ->
        DynamicTest.dynamicTest(why) {
            runBlocking {
                val (client, queue) = world("job-1")
                val awaited = awaiting(client.highlighting())
                queue.until("job:create")
                client.say("job:fail", "job-1", "mark", "error" to JsonPrimitive("the budget is spent"), *said)
                val ended = assertInstanceOf(JobError::class.java, failedWith(awaited))
                assertEquals(listOf("job.failed", "the budget is spent", JobId("job-1")), listOf(ended.code, ended.message, ended.jobId))
                client.close()
            }
        }
    }

    @Test
    fun anOptionOfAJobGivenAsNothingIsNotSent() = runBlocking {
        val (client, queue) = world("job-1", "job-2")
        val commenting = awaiting(client.mark.delegate(RESOURCE, CommentingJobParams(tone = null, density = 1.5, language = null)))
        queue.until("job:create")
        val generating = awaiting(client.generation(null))
        queue.until("job:create", 2)
        assertEquals(
            listOf(
                json("""{"jobType":"mark","resourceId":"res-1","params":{"motivation":"commenting","density":1.5}}"""),
                JsonObject(mapOf("jobType" to JsonPrimitive("yield"), "params" to JsonObject(mapOf("title" to JsonPrimitive("A summary"), "storageUri" to JsonPrimitive("file://a-summary.md"), "context" to CONTEXT)))),
            ),
            queue.asked("job:create").map { it.payload },
        )
        client.say("job:complete", "job-1")
        client.say("job:complete", "job-2", "yield")
        soon(commenting)
        soon(generating)
        client.close()
    }

    @Test
    fun aJobWhoseCreationIsRefusedIsItsFollowersFailure() = runBlocking {
        val (client, queue) = world("job-1")
        queue.refusesCreation = true
        val refused = assertInstanceOf(BusRequestError::class.java, failedWith(awaiting(client.highlighting())))
        assertEquals("bus.rejected", refused.code)
        client.close()
    }

    // A generation, which may stall.

    @Test
    fun aGenerationThatSaysNothingIsCancelledAndGivenUpOn() = runBlocking {
        val (client, queue) = world("job-1", timing = QUICK)
        // Its status says it is running for as long as it is asked: only the deadline ends it.
        queue.statuses(*Array(200) { status("running") })
        val stalled = awaiting(client.generation(STALL))
        queue.until("job:create")
        assertEquals(setOf("jobType", "params"), queue.asked("job:create").single().payload.keys)
        val created = queue.asked("job:create").single().atMs
        val ended = assertInstanceOf(JobError::class.java, failedWith(stalled))
        assertEquals(listOf("job.stalled", JobId("job-1")), listOf(ended.code, ended.jobId))
        assertEquals("The job stalled: nothing was heard of it within ${STALL}ms", ended.message)
        queue.until("job:cancel-requested")
        val cancel = queue.asked("job:cancel-requested").single()
        assertEquals(json("""{"jobId":"job-1"}"""), cancel.payload)
        assertTrue(cancel.atMs - created >= STALL - SLACK, "cancelled ${cancel.atMs - created}ms after the job's creation")
        client.close()
    }

    @Test
    fun aGenerationThatStallsBeforeItsJobIsKnownHasNothingToCancel() = runBlocking {
        val (client, queue) = world()
        val ended = assertInstanceOf(JobError::class.java, failedWith(awaiting(client.generation(STALL / 2))))
        assertEquals(listOf("job.stalled", null), listOf(ended.code, ended.jobId))
        delay(100)
        assertEquals(emptyList<Asked>(), queue.asked("job:cancel-requested"))
        client.close()
    }

    @Test
    fun whatAGenerationSaysStartsItsStallDeadlineAgainAndASetbackIsFollowedPast() = runBlocking {
        val (client, queue) = world("job-1")
        val read = following(client.generation(STALL))
        queue.until("job:create")
        delay(STALL * 2 / 3)
        client.say("job:report-progress", "job-1", "yield", *progress(10))
        delay(STALL * 2 / 3)
        // The setback was heard: a deadline left running would cancel the attempt that is coming.
        client.say("job:fail", "job-1", "yield", "error" to JsonPrimitive("a blip"), "willRetry" to JsonPrimitive(true))
        delay(STALL * 2 / 3)
        assertFalse(read.words.isCompleted)
        assertEquals(emptyList<Asked>(), queue.asked("job:cancel-requested"))
        client.say("job:complete", "job-1", "yield")
        assertEquals(listOf("created job-1", "progress 10", "failed", "complete"), soon(read.words))
        delay(STALL * 3 / 2)
        assertEquals(emptyList<Asked>(), queue.asked("job:cancel-requested"))
        client.close()
    }

    @Test
    fun howLongAGenerationMayBeSilentGrowsWithWhatWasAskedOfIt() {
        assertEquals(Timings.GENERATION_STALL_FLOOR_MS, generationStallDeadlineMs(null))
        assertEquals(Timings.GENERATION_STALL_FLOOR_MS, generationStallDeadlineMs(100.0))
        assertEquals(300_000L, generationStallDeadlineMs(4000.0))
        assertEquals(300_030L, generationStallDeadlineMs(4000.4))
        assertEquals(Timings.GENERATION_STALL_FLOOR_MS, generationStallDeadlineMs(-5.0))
    }

    // A client's waits, and its end.

    @Test
    fun aClientToldOtherWaitsKeepsThem() = runBlocking {
        val (client, queue) = world("job-1", timing = ClientTiming(jobSilenceMs = 50, jobStatusPollMs = 20))
        queue.statuses(status("complete"))
        // A twentieth of a second is waited out, and the job's status asked for.
        val done = soon(awaiting(client.highlighting()))
        assertEquals(JobId("job-1") to null, done.jobId to done.result)
        client.close()
    }

    @Test
    fun aClientThatClosesEndsTheJobsItWasFollowing() = runBlocking {
        val (client, queue) = world("job-1", "job-2")
        val read = following(client.highlighting())
        queue.until("job:create")
        val awaited = awaiting(client.highlighting())
        queue.until("job:create", 2)
        delay(50)
        client.close()
        assertEquals(listOf("created job-1", "error bus.closed"), soon(read.words))
        val closed = assertInstanceOf(BusRequestError::class.java, failedWith(awaited))
        assertEquals("bus.closed", closed.code)
    }

    private companion object {
        const val SILENCE = 600L
        const val POLL = 300L
        const val STALL = 1500L

        /** What a clock read on either side of a wait may be off by: the follower reads it a little before the queue does. */
        const val SLACK = 20L
        val QUICK = ClientTiming(jobSilenceMs = 50, jobStatusPollMs = 50)
    }
}
