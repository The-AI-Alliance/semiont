package semiont.jobs

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.serializer
import semiont.bus.Bus
import semiont.bus.Operations
import semiont.bus.decoded
import semiont.bus.replyChannelsFor
import semiont.bus.resultOf
import semiont.channels.Channels
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode
import semiont.errors.SemiontError
import semiont.telemetry.futureOf
import semiont.telemetry.noTrace
import semiont.transport.Broadcast
import semiont.transport.ConnectionState
import semiont.transport.Events
import semiont.transport.Frame
import semiont.transport.Transport
import semiont.transport.Variable
import semiont.transport.Watched
import semiont.types.JobClaimCommand
import semiont.types.JobFilter
import semiont.types.JobType
import semiont.types.wireJson
import java.time.Instant
import java.util.concurrent.CompletableFuture
import kotlin.time.TimeMark
import kotlin.time.TimeSource

/** What a worker's stream names for its claims: the replies of `job:claim`, and the two broadcasts a worker reads. */
internal val JOB_CLAIM_CHANNELS: List<String> = replyChannelsFor(Operations.JOB_CLAIM) + Channels.JOB_QUEUED.name + Channels.JOB_CANCEL_REQUESTED.name

/** What one claim came to: a job held, a refusal, or nothing pending. */
private sealed interface Answer {
    class Held(val job: HeldJob) : Answer

    class Refused(val refusal: ClaimRefusal) : Answer

    data object NonePending : Answer
}

/** What a held job asks of the claiming that handed it out. */
internal class Holder(
    val transport: Transport,
    val wire: Bus,
    /** The client's work, where a held job's Java calls and the failure of one let go of run: neither ends with the claiming. */
    val scope: CoroutineScope,
    /** How long each of a commit's requests waits to be answered. */
    val markCommitTimeoutMs: Long,
    /** The work showed it is alive. */
    val active: () -> Unit,
    /** The job is settled, and no longer held: whether it was completed. */
    val released: (HeldJob, Boolean) -> Unit,
)

/**
 * A worker's claims, from `job.claim`: each job the worker comes to hold, one
 * at a time (`next`), and each claim it was refused (`refused`)
 * (docs/protocol/WORKER-CONTRACT.md).
 *
 * The worker claims at every moment it becomes idle, and never otherwise:
 * once the stream is open after its claims are first read, when it settles
 * the job it holds, when a `job:queued` its filters take arrives while it
 * holds nothing, and when the stream opens again. One claim is in flight at a
 * time, and a wake-up during it earns exactly one more. A refusal does not
 * end the claims: the worker waits for its next idle moment, and what the
 * refusal means is its host's to judge. Claiming ends when `stop` is called,
 * which fails a job still held first, or when the stream ends. A claim is made
 * in no trace, and a job it hands over states the trace its reply arrived in.
 */
public class Claims internal constructor(
    private val transport: Transport,
    private val accepts: List<JobFilter>,
    parent: CoroutineScope,
    private val clock: TimeSource,
    private val jobClaimTimeoutMs: Long,
    private val heldJobStallMs: Long,
    private val heldJobStallCheckMs: Long,
    markCommitTimeoutMs: Long,
) {
    private val scope = CoroutineScope(parent.coroutineContext + SupervisorJob(parent.coroutineContext[Job]))

    /** Each filter as the wire carries it: what an announcement is compared with. */
    private val filters: List<JsonObject> = accepts.map { wireJson.encodeToJsonElement(serializer<JobFilter>(), it).jsonObject }
    private val client = parent
    private val holder = Holder(transport, Bus(transport), parent, markCommitTimeoutMs, ::active, ::releasedJob)
    private val handed = Channel<HeldJob>(Channel.UNLIMITED)
    private val refusals = Broadcast<ClaimRefusal>(keepForFirst = true)
    private val stall = Variable<HeldJobStall?>(null)
    private val listening = mutableListOf<Events<Frame>>()

    /** What watches for idle moments, cancellations and stalls: stopped when the claiming ends. */
    private val watching = mutableListOf<Job>()
    private val lock = Any()

    private var begun = false
    private var stopped = false
    private var held: HeldJob? = null
    private var cancelling: Variable<Boolean>? = null
    private var stallReported = false
    private var claimInFlight: Job? = null

    // One claim in flight at a time, and a wake-up that arrived during it, honoured with exactly one more claim.
    private var claiming = false
    private var wakePending = false

    private var lastQueuedEventAt: Instant? = null
    private var lastClaimAt: Instant? = null
    private var lastFinishedAt: Instant? = null
    private var lastActivityAt: Instant? = null

    /** When the work was last active, by the client's clock, which a silence is measured on. */
    private var activeMark: TimeMark? = null
    private var heldSince: Instant? = null
    private var jobsCompleted = 0L

    /** The last stall found: a held job that has shown no activity for the stall threshold, reported once. Each one after is a change. */
    public val stalled: Watched<HeldJobStall?> = stall.reading()

    /**
     * The next job the worker comes to hold, once the one before it is
     * settled: none once the claims have ended. The first call begins
     * claiming. Throws `BusRequestError` (`bus.unsubscribed`) for a transport
     * whose stream does not name what claiming reads.
     */
    public suspend fun next(): HeldJob? {
        begin()
        while (true) {
            val job = handed.receiveCatching().getOrNull() ?: return null
            // Claimed, and failed by the worker's stop before anybody read it.
            if (!job.settled) return job
        }
    }

    /** `next`, for Java. */
    public fun nextFuture(): CompletableFuture<HeldJob?> = client.futureOf { next() }

    /** Each claim refused from now on; the first reader is also given those refused before it read. */
    public fun refused(): Events<ClaimRefusal> = refusals.listen()

    /** What this worker can say of itself now. */
    public fun vitals(): WorkerVitals = synchronized(lock) {
        val holding = held
        val since = heldSince
        WorkerVitals(
            lastQueuedEventAt = lastQueuedEventAt,
            lastClaimAt = lastClaimAt,
            lastFinishedAt = lastFinishedAt,
            lastActivityAt = lastActivityAt,
            activeJob = if (holding == null || since == null) null else ActiveJob(holding.jobId, holding.jobType, since),
            jobsCompleted = jobsCompleted,
        )
    }

    /**
     * Stop claiming. A job still held is failed first, and this returns once
     * that has been said, or could not be. A claim in flight is waited for,
     * up to its timeout: a job it is answered with is failed too.
     */
    public suspend fun stop() {
        val (holding, inFlight) = synchronized(lock) { held to claimInFlight }
        end()
        holding?.failFor(STOPPED_WHILE_HELD)
        inFlight?.join()
        synchronized(lock) { listening.toList().also { listening.clear() } }.forEach { it.close() }
        scope.cancel()
        stall.end()
    }

    /** `stop`, for Java. */
    public fun stopFuture(): CompletableFuture<Unit> = client.futureOf { stop() }

    private fun begin() {
        synchronized(lock) {
            if (begun) return
            begun = true
        }
        val unnamed = JOB_CLAIM_CHANNELS.filterNot(transport::isSubscribed)
        if (unnamed.isNotEmpty()) {
            throw BusRequestError(
                BusRequestErrorCode.Unsubscribed,
                "This transport's stream does not name ${unnamed.joinToString(", ")}: a worker on it would never be answered, woken or told of a cancellation. " +
                    "Name the replies of job:claim, job:queued and job:cancel-requested among its channels.",
            )
        }
        // Both broadcasts are read as they come, not as this SDK types them: the comparison of an announcement with a
        // filter knows no field by name, so a job this SDK cannot type still wakes a worker whose claim it matches.
        val announced = transport.frames(Channels.JOB_QUEUED.name)
        val cancellations = transport.frames(Channels.JOB_CANCEL_REQUESTED.name)
        val watchers = listOf(
            scope.launch {
                announced.collect { frame ->
                    synchronized(lock) { lastQueuedEventAt = Instant.now() }
                    if (filters.any { jobMatchesFilter(it, frame.payload) }) pull()
                }
                // The stream has ended: nothing more can be claimed.
                end()
            },
            scope.launch {
                cancellations.collect { frame ->
                    // A cancellation is the held job's only when it names it, and one that arrives after the settle signals nothing.
                    val (holding, signal) = synchronized(lock) { held to cancelling }
                    val named = (frame.payload["jobId"] as? JsonPrimitive)?.content
                    if (holding != null && signal != null && !holding.settled && named == holding.jobId.value) signal.set(true)
                }
            },
            scope.launch { watchTheStream() },
            scope.launch { lookForStalls() },
        )
        synchronized(lock) {
            listening += listOf(announced, cancellations)
            watching += watchers
        }
    }

    /** The stream opening again is a change to open after the first sight of it, which decides whether the first claim is made now or waits. */
    private suspend fun watchTheStream() {
        var wasOpen = false
        transport.state.collect { now ->
            val isOpen = now == ConnectionState.Open
            if (isOpen && !wasOpen) pull()
            wasOpen = isOpen
        }
    }

    private suspend fun lookForStalls() {
        while (true) {
            delay(heldJobStallCheckMs)
            val found = synchronized(lock) {
                val holding = held ?: return@synchronized null
                val mark = activeMark ?: return@synchronized null
                val since = heldSince ?: return@synchronized null
                val last = lastActivityAt ?: return@synchronized null
                if (stallReported) return@synchronized null
                val silentForMs = mark.elapsedNow().inWholeMilliseconds
                if (silentForMs <= heldJobStallMs) return@synchronized null
                stallReported = true
                HeldJobStall(holding.jobId, holding.jobType, since, last, silentForMs, heldJobStallMs)
            }
            found?.let(stall::set)
        }
    }

    /** The work showed it is alive. */
    private fun active(): Unit = synchronized(lock) {
        lastActivityAt = Instant.now()
        activeMark = clock.markNow()
    }

    /** `job` is settled, and no longer held. */
    private fun releasedJob(job: HeldJob, completed: Boolean) {
        val ending = synchronized(lock) {
            if (held !== job) return
            lastActivityAt = Instant.now()
            activeMark = clock.markNow()
            lastFinishedAt = lastActivityAt
            held = null
            heldSince = null
            if (completed) jobsCompleted++
            cancelling.also { cancelling = null }
        }
        // Settled: no cancellation is signalled to it now, and whoever watches for one is told so.
        ending?.end()
        pull()
    }

    /** One idle moment: ask once, or remember that it was asked to. */
    private fun pull() {
        synchronized(lock) {
            if (stopped || held != null) return
            if (claiming) {
                wakePending = true
                return
            }
            claiming = true
            wakePending = false
            // In no trace: the claim, and the reading of its answer, whatever span the idle moment came in.
            claimInFlight = scope.launch(noTrace()) { claim() }
        }
    }

    private suspend fun claim() {
        val answered = claimNext()
        val again = synchronized(lock) {
            claiming = false
            if (stopped) {
                null
            } else if (answered is Answer.Held) {
                lastActivityAt = Instant.now()
                activeMark = clock.markNow()
                lastClaimAt = lastActivityAt
                heldSince = lastActivityAt
                stallReported = false
                // A wake-up that arrived during the claim is moot: the settle claims.
                wakePending = false
                held = answered.job
                false
            } else {
                wakePending.also { wakePending = false }
            }
        }
        when {
            // Answered after the worker stopped: the job is this worker's at the dispatcher, and nobody here will run it.
            again == null -> if (answered is Answer.Held) answered.job.failFor(STOPPED_WHILE_HELD)
            answered is Answer.Held -> handed.trySend(answered.job)
            else -> {
                if (answered is Answer.Refused) refusals.deliver(answered.refusal)
                if (again) pull()
            }
        }
    }

    /**
     * Ask once: the job claimed, the refusal, or nothing when nothing is
     * pending. A reply that does not read as a claimed job is refused here
     * and never run (WORKER-CONTRACT C9).
     */
    private suspend fun claimNext(): Answer {
        val asked = wireJson.encodeToJsonElement(JobClaimCommand.serializer(), JobClaimCommand(accepts = accepts)).jsonObject
        val reply = try {
            resultOf(transport, Operations.JOB_CLAIM, asked, jobClaimTimeoutMs)
        } catch (refused: BusRequestError) {
            if (refused.reason == BusRequestErrorCode.NonePending) return Answer.NonePending
            return Answer.Refused(ClaimRefusal(refused.reason, refused.message ?: ""))
        } catch (failed: SemiontError) {
            return Answer.Refused(ClaimRefusal(null, failed.message ?: ""))
        }
        val claimed = try {
            decoded(Operations.JOB_CLAIM.result, reply.payload).response
        } catch (unreadable: IllegalArgumentException) {
            return Answer.Refused(ClaimRefusal(null, "The reply to job:claim is no claimed job: ${unreadable.message}"))
        }
        val signal = Variable(false)
        synchronized(lock) { cancelling = signal }
        return Answer.Held(
            when (claimed.metadata.type) {
                JobType.Mark -> HeldMarkJob(holder, claimed, signal, reply.trace)
                JobType.Yield -> HeldYieldJob(holder, claimed, signal, reply.trace)
            },
        )
    }

    /** Nothing more is claimed or handed out, and what watched for an idle moment stops watching. A claim in flight is left to be answered. */
    private fun end() {
        val watchers = synchronized(lock) {
            if (stopped) return
            stopped = true
            watching.toList()
        }
        handed.close()
        refusals.close()
        watchers.forEach { it.cancel() }
    }
}
