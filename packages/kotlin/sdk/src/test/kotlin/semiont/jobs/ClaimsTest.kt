@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package semiont.jobs

import io.opentelemetry.api.trace.Span
import io.opentelemetry.api.trace.SpanContext
import io.opentelemetry.api.trace.TraceFlags
import io.opentelemetry.api.trace.TraceState
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.serializer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import semiont.ClientTiming
import semiont.Recording
import semiont.SemiontClient
import semiont.bus.Operations
import semiont.bus.replyChannelsFor
import semiont.channels.Channels
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode
import semiont.identifiers.AnnotationId
import semiont.identifiers.JobId
import semiont.identifiers.ResourceId
import semiont.sameJson
import semiont.transport.ConnectionState
import semiont.types.Annotation
import semiont.types.DurabilityEvidence
import semiont.types.FailureClass
import semiont.types.JobFilter
import semiont.types.JobProgress
import semiont.types.JobType
import semiont.types.MarkJobDone
import semiont.types.UnitCursor
import semiont.types.YieldJobDone
import semiont.types.wireJson
import kotlin.time.Duration.Companion.seconds

/** Every job: a mark job of each motivation, and a yield job. */
private val EVERY_FILTER = JsonArray(
    listOf("highlighting", "commenting", "assessing", "linking", "tagging").map { obj("jobType" to "mark", "params" to obj("motivation" to it)) } + obj("jobType" to "yield"),
)
private val EVERYTHING: List<JobFilter> = wireJson.decodeFromJsonElement(ListSerializer(serializer<JobFilter>()), EVERY_FILTER)
private val TAGGING: List<JobFilter> = wireJson.decodeFromJsonElement(
    ListSerializer(serializer<JobFilter>()),
    JsonArray(listOf(obj("jobType" to "mark", "params" to obj("motivation" to "tagging")))),
)
private val RESOURCE = ResourceId("res-1")
private val NOT_THERE = obj("message" to "Annotation not found")

/** How long a test may take: one that waits for what never comes fails, rather than waits for good. */
private val LIMIT = 10.seconds

/** How long a commit's requests wait here. */
private const val QUICK = 200L

private fun made(id: String): Annotation = wireJson.decodeFromJsonElement(serializer<Annotation>(), annotation(id))

/**
 * A client over a desk, on the test's clock. Its work is the test's
 * background work, so a test that fails before it stops its claims leaves no
 * timer running for good.
 */
private class World(test: TestScope, wire: List<Fault> = emptyList(), channels: Collection<String>? = null) {
    val clock = StandardTestDispatcher(test.testScheduler)
    val desk = Desk(clock, wire, channels)
    private val gateway = Recording()
    val client = SemiontClient(desk, gateway, gateway, ClientTiming(), null, clock + SupervisorJob(test.backgroundScope.coroutineContext.job), test.testScheduler.timeSource)

    fun over() {
        client.close()
        desk.close()
    }
}

/** Whether `said` is `expected`, numbers by what they are. */
private fun assertSaid(expected: List<Pair<String, JsonObject>>, said: List<Pair<String, JsonObject>>) {
    assertEquals(expected.map { it.first }, said.map { it.first }, "said $said")
    for ((one, other) in expected.zip(said)) assertTrue(sameJson(one.second, other.second), "said ${other.second}, not ${one.second}")
}

private fun assertSent(expected: List<JsonObject>, sent: List<JsonObject>) {
    assertEquals(expected.size, sent.size, "sent $sent")
    for ((one, other) in expected.zip(sent)) assertTrue(sameJson(one, other), "sent $other, not $one")
}

private suspend fun held(claims: Claims): HeldJob = checkNotNull(claims.next()) { "the claims ended" }

private suspend fun finish(job: HeldJob) = assertInstanceOf(HeldMarkJob::class.java, job).complete(MarkJobDone(found = 0, persisted = 0))

/** A span of the trace `digit` names, made current: as a worker's code is inside the span it opened for a job. */
private fun <T> inSpan(digit: Char, work: () -> T): T {
    val context = SpanContext.create(digit.toString().repeat(32), digit.toString().repeat(16), TraceFlags.getSampled(), TraceState.getDefault())
    return Span.wrap(context).makeCurrent().use { work() }
}

/**
 * A worker's side of the queue (docs/protocol/WORKER-CONTRACT.md) beyond what
 * the worker conformance suite holds on the wire: what a host is handed and
 * reads, and how each settle and commit is said.
 */
class ClaimsTest {
    // Claiming (C1 to C10).

    @Test
    fun claimsNothingUntilReadThenClaimsAndHoldsTheJobAsTheRecordStatesIt() = runTest(timeout = LIMIT) {
        val w = World(this)
        val cursor = obj("next" to 1200, "size" to 800, "found" to 4, "emitted" to 3, "errors" to 0)
        w.desk.offered += running("job-1", metadata = obj("retryCount" to 1, "maxRetries" to 3, "completedUnits" to JsonArray(listOf(JsonPrimitive("Person"))), "unitCursors" to obj("Place" to cursor)))
        val claims = w.client.job.claim(EVERYTHING)
        runCurrent()
        assertEquals(emptyList<JsonObject>(), w.desk.sent("job:claim"), "nothing is claimed until the claims are read")
        val job = held(claims)
        assertSent(listOf(obj("accepts" to EVERY_FILTER)), w.desk.sent("job:claim"))
        assertEquals(JobId("job-1"), job.jobId)
        assertEquals(JobType.Mark, job.jobType)
        assertEquals(RESOURCE, job.resourceId)
        assertEquals(listOf("Person"), job.completedUnits)
        assertEquals(mapOf("Place" to wireJson.decodeFromJsonElement(serializer<UnitCursor>(), cursor)), job.unitCursors)
        assertEquals(1L to 3L, job.retryCount to job.maxRetries)
        assertEquals(2L, job.attempt)
        assertNull(job.annotationId)
        assertFalse(job.settled)
        claims.stop()
        w.over()
    }

    @Test
    fun claimsAgainWhenAJobIsSettledAndAnAnnouncementWhileOneIsHeldIsIgnored() = runTest(timeout = LIMIT) {
        val w = World(this)
        w.desk.offered += running("job-1")
        val claims = w.client.job.claim(EVERYTHING)
        val job = held(claims)
        w.desk.relay("job:queued", queued("highlighting"))
        runCurrent()
        assertEquals(1, w.desk.sent("job:claim").size, "the settle claims")
        finish(job)
        runCurrent()
        assertEquals(2, w.desk.sent("job:claim").size)
        claims.stop()
        w.over()
    }

    @Test
    fun aMatchingAnnouncementClaimsAndOneThatMatchesNoFilterDoesNot() = runTest(timeout = LIMIT) {
        val w = World(this)
        val claims = w.client.job.claim(TAGGING)
        val reading = async { claims.next() }
        runCurrent()
        assertEquals(1, w.desk.sent("job:claim").size, "nothing was pending")
        w.desk.relay("job:queued", queued("highlighting"))
        runCurrent()
        assertEquals(1, w.desk.sent("job:claim").size, "an announcement no filter takes wakes nothing")
        w.desk.offered += running("job-1", params = obj("motivation" to "tagging"))
        w.desk.relay("job:queued", queued("tagging"))
        runCurrent()
        assertEquals(2, w.desk.sent("job:claim").size)
        assertEquals(JobId("job-1"), reading.await()?.jobId)
        claims.stop()
        w.over()
    }

    @Test
    fun anAnnouncementWhileAClaimIsInFlightEarnsExactlyOneMoreClaim() = runTest(timeout = LIMIT) {
        val w = World(this, wire = listOf(Fault.DROP, Fault.DELIVER))
        val claims = w.client.job.claim(EVERYTHING, jobClaimTimeoutMs = 1_000)
        val reading = async { claims.next() }
        runCurrent()
        assertEquals(1, w.desk.sent("job:claim").size)
        // Two wake-ups during the claim in flight earn one claim, made once it is answered.
        w.desk.relay("job:queued", queued("tagging"))
        w.desk.relay("job:queued", queued("tagging"))
        runCurrent()
        assertEquals(1, w.desk.sent("job:claim").size, "one claim is in flight at a time")
        advanceTimeBy(1_001)
        runCurrent()
        assertEquals(2, w.desk.sent("job:claim").size)
        runCurrent()
        assertEquals(2, w.desk.sent("job:claim").size, "and exactly one")
        reading.cancel()
        claims.stop()
        w.over()
    }

    @Test
    fun claimsWhenTheStreamOpensAndWhenItOpensAgain() = runTest(timeout = LIMIT) {
        val w = World(this)
        w.desk.connection.value = ConnectionState.Connecting
        val claims = w.client.job.claim(EVERYTHING)
        val reading = async { claims.next() }
        runCurrent()
        assertEquals(0, w.desk.sent("job:claim").size, "a claim on a stream not yet open would only be refused")
        w.desk.connection.value = ConnectionState.Open
        runCurrent()
        assertEquals(1, w.desk.sent("job:claim").size)
        w.desk.connection.value = ConnectionState.Reconnecting
        runCurrent()
        w.desk.connection.value = ConnectionState.Open
        runCurrent()
        assertEquals(2, w.desk.sent("job:claim").size)
        reading.cancel()
        claims.stop()
        w.over()
    }

    @Test
    fun aRefusalIsHandedOutWithItsCodeAndAReplyThatNamesNoJobIsRefusedHere() = runTest(timeout = LIMIT) {
        val w = World(this)
        w.desk.refusals += obj("message" to "no worker role", "code" to "unauthorized")
        w.desk.offered += obj("status" to "running")
        val claims = w.client.job.claim(EVERYTHING)
        val refused = mutableListOf<ClaimRefusal>()
        backgroundScope.launch { claims.refused().collect { refused += it } }
        val reading = async { claims.next() }
        runCurrent()
        assertEquals(listOf(BusRequestErrorCode.Unauthorized to "no worker role"), refused.map { it.code to it.message })
        // Its next idle moment: the reply that names no job is refused here, and never run.
        w.desk.relay("job:queued", queued("tagging"))
        runCurrent()
        assertEquals(2, refused.size)
        assertNull(refused[1].code)
        // And nothing pending is no refusal.
        w.desk.relay("job:queued", queued("tagging"))
        runCurrent()
        assertEquals(3, w.desk.sent("job:claim").size)
        assertEquals(2, refused.size)
        assertFalse(reading.isCompleted)
        reading.cancel()
        claims.stop()
        w.over()
    }

    @Test
    fun aClaimNotAnsweredInTimeIsReportedAsARefusal() = runTest(timeout = LIMIT) {
        val w = World(this, wire = listOf(Fault.DROP))
        val claims = w.client.job.claim(EVERYTHING, jobClaimTimeoutMs = 500)
        val refused = claims.refused()
        val reading = async { claims.next() }
        advanceTimeBy(501)
        runCurrent()
        assertEquals(BusRequestErrorCode.Timeout, refused.first().code)
        reading.cancel()
        claims.stop()
        w.over()
    }

    @Test
    fun aStreamThatDoesNotNameWhatClaimingReadsCannotCarryAWorkersClaims() = runTest(timeout = LIMIT) {
        val w = World(this, channels = replyChannelsFor(Operations.JOB_CLAIM) + Channels.JOB_QUEUED.name)
        val claims = w.client.job.claim(EVERYTHING)
        val refused = assertThrows<BusRequestError> { claims.next() }
        assertEquals(BusRequestErrorCode.Unsubscribed, refused.reason)
        assertTrue(refused.message!!.contains(Channels.JOB_CANCEL_REQUESTED.name), refused.message)
        assertEquals(emptyList<JsonObject>(), w.desk.sent("job:claim"))
        w.over()
    }

    // The lifecycle (L1 to L8).

    @Test
    fun aHeldJobSaysItsWholeLifecycleItself() = runTest(timeout = LIMIT) {
        val w = World(this)
        w.desk.offered += running("job-1", metadata = obj("retryCount" to 1))
        val cursor = obj("next" to 1200, "size" to 800, "found" to 4, "emitted" to 3, "errors" to 0)
        val claims = w.client.job.claim(EVERYTHING, markCommitTimeoutMs = QUICK)
        val job = assertInstanceOf(HeldMarkJob::class.java, held(claims))
        job.start()
        job.progress(JobProgress(percentage = 40.0))
        job.checkpoint(listOf("Person"), mapOf("Place" to wireJson.decodeFromJsonElement(serializer<UnitCursor>(), cursor)))
        job.commit(RESOURCE, listOf(made("ann-1")))
        job.complete(MarkJobDone(found = 9, persisted = 7))
        assertTrue(job.settled)
        val again = assertThrows<IllegalStateException> { job.fail("too late") }
        assertTrue(again.message!!.contains("already settled"), again.message)
        val identity = obj("resourceId" to "res-1", "jobId" to "job-1", "jobType" to "mark", "attempt" to 2)
        assertSaid(
            listOf(
                "job:start" to identity,
                "job:report-progress" to JsonObject(identity + obj("percentage" to 40, "progress" to obj("percentage" to 40))),
                "job:checkpoint" to obj("jobId" to "job-1", "completedUnits" to JsonArray(listOf(JsonPrimitive("Person"))), "unitCursors" to obj("Place" to cursor)),
                "job:complete" to JsonObject(identity + obj("result" to obj("found" to 9, "persisted" to 7), "durability" to "acknowledged")),
            ),
            w.desk.said(),
        )
        claims.stop()
        w.over()
    }

    @Test
    fun aYieldJobFocusedOnAnAnnotationIsAnchoredToItAndSaysSo() = runTest(timeout = LIMIT) {
        val w = World(this)
        w.desk.offered += running(
            "job-1",
            "yield",
            metadata = obj("maxRetries" to 0),
            params = obj("context" to obj("focus" to obj("kind" to "annotation", "annotation" to obj("id" to "ann-7")))),
        )
        val claims = w.client.job.claim(EVERYTHING)
        val job = assertInstanceOf(HeldYieldJob::class.java, held(claims))
        assertEquals(AnnotationId("ann-7"), job.annotationId)
        job.start()
        val twice = assertThrows<IllegalStateException> { job.start() }
        assertTrue(twice.message!!.contains("first message"), twice.message)
        job.progress(JobProgress(percentage = 5.0))
        job.complete(YieldJobDone(resourceId = job.resourceId, resourceName = "Ouranos", truncated = false))
        val identity = obj("resourceId" to "res-1", "jobId" to "job-1", "jobType" to "yield", "attempt" to 1, "annotationId" to "ann-7")
        val said = w.desk.said()
        assertSaid(listOf("job:start" to identity), said.take(1))
        assertTrue(sameJson(obj("percentage" to 5, "annotationId" to "ann-7"), said[1].second.getValue("progress")), "progress ${said[1].second}")
        assertSaid(listOf("job:complete" to JsonObject(identity + obj("result" to obj("resourceId" to "res-1", "resourceName" to "Ouranos", "truncated" to false)))), said.drop(2))
        claims.stop()
        w.over()
    }

    @Test
    fun aFailureSaysWhetherItWillBeRetriedAndACancelSaysOnlyWhatItsCommandNames() = runTest(timeout = LIMIT) {
        val w = World(this)
        w.desk.offered += listOf(running("job-1", metadata = obj("retryCount" to 0, "maxRetries" to 1)), running("job-2", metadata = obj("retryCount" to 1, "maxRetries" to 1)), running("job-3"))
        val claims = w.client.job.claim(EVERYTHING)
        held(claims).fail("the model timed out", completedUnits = listOf("Person"))
        held(claims).fail("the model timed out")
        held(claims).cancel(listOf("Person"))
        val base = obj("resourceId" to "res-1", "jobType" to "mark")
        assertSent(
            listOf(
                // A class the worker does not know is not stated.
                JsonObject(base + obj("jobId" to "job-1", "attempt" to 1, "error" to "the model timed out", "completedUnits" to JsonArray(listOf(JsonPrimitive("Person"))), "willRetry" to true)),
                JsonObject(base + obj("jobId" to "job-2", "attempt" to 2, "error" to "the model timed out", "willRetry" to false)),
            ),
            w.desk.sent("job:fail"),
        )
        assertSent(listOf(JsonObject(base + obj("jobId" to "job-3", "completedUnits" to JsonArray(listOf(JsonPrimitive("Person")))))), w.desk.sent("job:cancel"))
        claims.stop()
        w.over()
    }

    @Test
    fun aCancellationThatNamesTheHeldJobIsSignalledAndAnyOtherIsNot() = runTest(timeout = LIMIT) {
        val w = World(this)
        w.desk.offered += running("job-1")
        val claims = w.client.job.claim(EVERYTHING)
        val job = held(claims)
        w.desk.relay("job:cancel-requested", obj("jobId" to "job-7"))
        runCurrent()
        assertFalse(job.cancelled.value)
        w.desk.relay("job:cancel-requested", obj("jobId" to "job-1"))
        runCurrent()
        assertTrue(job.cancelled.value)
        job.cancel()
        // Settled, it is told no more, and its readers end.
        assertEquals(listOf(true), launch { job.cancelled.collect {} }.let { runCurrent(); assertTrue(it.isCompleted); listOf(job.cancelled.value) })
        claims.stop()
        w.over()
    }

    @Test
    fun aWorkerThatStopsFailsTheJobItHoldsAndAJobLetGoUnsettledIsFailed() = runTest(timeout = LIMIT) {
        val w = World(this)
        w.desk.offered += listOf(running("job-1"), running("job-2"))
        val claims = w.client.job.claim(EVERYTHING)
        held(claims).use { }
        runCurrent()
        assertEquals(listOf("The worker let go of the job without settling it"), w.desk.sent("job:fail").map { (it.getValue("error") as JsonPrimitive).content })
        val stoppedWith = held(claims)
        claims.stop()
        assertSent(
            listOf(obj("resourceId" to "res-1", "jobId" to "job-2", "jobType" to "mark", "attempt" to 1, "error" to "The worker stopped while it held the job", "willRetry" to true)),
            w.desk.sent("job:fail").drop(1),
        )
        assertTrue(stoppedWith.settled)
        assertNull(claims.next())
        assertEquals(2, w.desk.sent("job:claim").size, "and it claims nothing more")
        w.over()
    }

    // Commits (A1, A4, A5, A6).

    /** A worker holding `job-1` on a wire where each commit observes as `observed` says, in order; and what each commit did. */
    private suspend fun TestScope.committing(vararg observed: DurabilityEvidence, then: suspend (World, HeldJob, List<BusRequestError?>) -> Unit) {
        val wire = mutableListOf(Fault.DELIVER)
        for (how in observed) {
            when (how) {
                DurabilityEvidence.Acknowledged -> wire += Fault.DELIVER
                DurabilityEvidence.ProbeConfirmed, DurabilityEvidence.ProbeRefused -> wire += listOf(Fault.DROP, Fault.DELIVER)
                DurabilityEvidence.ProbeUnreachable -> wire += listOf(Fault.DROP, Fault.DROP)
            }
        }
        // The claim the settle makes.
        wire += Fault.DELIVER
        val w = World(this, wire = wire)
        w.desk.offered += running("job-1")
        val claims = w.client.job.claim(EVERYTHING, markCommitTimeoutMs = QUICK)
        val job = held(claims)
        val did = observed.mapIndexed { at, how ->
            if (how == DurabilityEvidence.ProbeRefused) w.desk.askedOf["ann-$at"] = NOT_THERE
            try {
                job.commit(RESOURCE, listOf(made("ann-$at")))
                null
            } catch (failed: BusRequestError) {
                failed
            }
        }
        then(w, job, did)
        claims.stop()
        w.over()
    }

    @Test
    fun aCommitCitesTheJobAndIsEstablishedWhenTheRecordAcknowledgesIt() = runTest(timeout = LIMIT) {
        committing(DurabilityEvidence.Acknowledged) { w, job, did ->
            assertEquals(listOf(null), did)
            assertSent(listOf(obj("jobId" to "job-1", "resourceId" to "res-1", "annotations" to JsonArray(listOf(annotation("ann-0"))))), w.desk.sent("mark:commit"))
            assertEquals(emptyList<JsonObject>(), w.desk.sent("browse:annotation-requested"), "nothing is asked")
            finish(job)
            assertEquals(JsonPrimitive("acknowledged"), w.desk.sent("job:complete").single()["durability"])
        }
    }

    @Test
    fun aBatchOfNoAnnotationsIsNoCommitAndAJobThatCommittedNothingStatesNothing() = runTest(timeout = LIMIT) {
        committing { w, job, _ ->
            job.commit(RESOURCE, emptyList())
            assertEquals(emptyList<JsonObject>(), w.desk.sent("mark:commit"))
            finish(job)
            assertNull(w.desk.sent("job:complete").single()["durability"])
        }
    }

    @Test
    fun aCommitTheRecordRefusesRaisesItsReasonAndNothingIsAskedOrObserved() = runTest(timeout = LIMIT) {
        val w = World(this)
        w.desk.offered += running("job-1")
        w.desk.refusingCommits = true
        val claims = w.client.job.claim(EVERYTHING, markCommitTimeoutMs = QUICK)
        val job = held(claims)
        val refused = assertThrows<BusRequestError> { job.commit(RESOURCE, listOf(made("ann-1"))) }
        assertEquals("the record could not append", refused.message)
        assertEquals(emptyList<JsonObject>(), w.desk.sent("browse:annotation-requested"))
        job.fail("the record refused")
        assertNull(w.desk.sent("job:fail").single()["durability"])
        claims.stop()
        w.over()
    }

    @Test
    fun aCommitNobodyAcknowledgesAsksAboutTheBatchsLastAnnotationAndIsEstablishedWhenItIsThere() = runTest(timeout = LIMIT) {
        committing(DurabilityEvidence.ProbeConfirmed) { w, job, did ->
            assertEquals(listOf(null), did)
            assertEquals(listOf("ann-0"), w.desk.sent("browse:annotation-requested").map { (it.getValue("annotationId") as JsonPrimitive).content })
            finish(job)
            assertEquals(JsonPrimitive("probe-confirmed"), w.desk.sent("job:complete").single()["durability"])
        }
    }

    @Test
    fun answeredThatItIsNotThereTheCommitRaisesWhatItsRequestDidAndTheFailureSaysWhatWasObserved() = runTest(timeout = LIMIT) {
        committing(DurabilityEvidence.ProbeRefused) { w, job, did ->
            assertEquals(BusRequestErrorCode.Timeout, did.single()?.reason)
            job.fail("the batch did not land", failureClass = FailureClass.Deterministic)
            val failed = w.desk.sent("job:fail").single()
            assertEquals(JsonPrimitive("probe-refused"), failed["durability"])
            assertEquals(JsonPrimitive(false), failed["willRetry"])
        }
    }

    @Test
    fun notAnsweredTheCommitRaisesTheSameAndTheFailureSaysNobodyAnswered() = runTest(timeout = LIMIT) {
        committing(DurabilityEvidence.ProbeUnreachable) { w, job, did ->
            assertEquals(BusRequestErrorCode.Timeout, did.single()?.reason)
            job.fail("the batch may not have landed")
            assertEquals(JsonPrimitive("probe-unreachable"), w.desk.sent("job:fail").single()["durability"])
        }
    }

    @Test
    fun aCompletionSaysTheWeakestOfWhatTheJobsCommitsObservedAndAFailureNothingWhenAllWereEstablished() = runTest(timeout = LIMIT) {
        committing(DurabilityEvidence.Acknowledged, DurabilityEvidence.ProbeConfirmed, DurabilityEvidence.Acknowledged) { w, job, _ ->
            finish(job)
            assertEquals(JsonPrimitive("probe-confirmed"), w.desk.sent("job:complete").single()["durability"])
        }
        committing(DurabilityEvidence.ProbeConfirmed) { w, job, _ ->
            job.fail("the model refused")
            assertNull(w.desk.sent("job:fail").single()["durability"])
        }
        committing(DurabilityEvidence.ProbeUnreachable, DurabilityEvidence.ProbeRefused) { w, job, _ ->
            job.fail("the batches may not have landed")
            assertEquals(JsonPrimitive("probe-unreachable"), w.desk.sent("job:fail").single()["durability"], "of two equally weak, the first seen")
        }
    }

    @Test
    fun aSettledJobCommitsNothing() = runTest(timeout = LIMIT) {
        committing { w, job, _ ->
            finish(job)
            assertThrows<IllegalStateException> { job.commit(RESOURCE, listOf(made("ann-9"))) }
            assertEquals(emptyList<JsonObject>(), w.desk.sent("mark:commit"))
        }
    }

    // Liveness (V1, V2).

    @Test
    fun vitalsSayWhatTheWorkerHoldsAndHasDoneAndASilentHeldJobIsStalled() = runTest(timeout = LIMIT) {
        val w = World(this)
        w.desk.offered += running("job-1")
        val claims = w.client.job.claim(EVERYTHING, heldJobStallMs = 400, heldJobStallCheckMs = 100)
        val empty = claims.vitals()
        assertEquals(Triple(null, null, 0L), Triple(empty.lastClaimAt, empty.activeJob, empty.jobsCompleted))
        val job = held(claims)
        val holding = claims.vitals()
        assertEquals(JobId("job-1"), holding.activeJob?.jobId)
        assertEquals(holding.lastClaimAt, holding.activeJob?.since)
        w.desk.relay("job:queued", queued("highlighting"))
        runCurrent()
        assertNotNull(claims.vitals().lastQueuedEventAt)
        // It reports for a second, well past the threshold, and is never stalled.
        repeat(10) { step ->
            advanceTimeBy(100)
            job.progress(JobProgress(percentage = step.toDouble()))
        }
        runCurrent()
        assertNull(claims.stalled.value, "however long it runs")
        advanceTimeBy(600)
        runCurrent()
        val stall = checkNotNull(claims.stalled.value) { "no stall was found" }
        assertEquals(JobId("job-1") to 400L, stall.jobId to stall.thresholdMs)
        assertTrue(stall.silentForMs > 400, "silent for ${stall.silentForMs}")
        finish(job)
        val done = claims.vitals()
        assertEquals(null to 1L, done.activeJob to done.jobsCompleted)
        assertNotNull(done.lastFinishedAt)
        claims.stop()
        w.over()
    }

    // Traces (T1).

    @Test
    fun aClaimIsMadeInNoTraceAndAHeldJobStatesTheTraceItsReplyArrivedIn() = runTest(timeout = LIMIT) {
        val w = World(this)
        w.desk.offered += running("job-1")
        val claims = w.client.job.claim(EVERYTHING)
        val job = inSpan('a') { async { claims.next() } }.await()!!
        assertEquals(listOf<String?>(null), w.desk.claimedIn, "the first claim is made in no trace, whatever span the claims are read in")
        assertNull(job.trace, "a reply that arrived in no trace")
        w.desk.offered += running("job-2")
        // The settle runs inside the job's span; the claim it makes is in no trace.
        inSpan('b') { launch { finish(job) } }
        runCurrent()
        assertEquals(listOf<String?>(null, null), w.desk.claimedIn)
        claims.stop()
        w.over()
    }
}
