package semiont.testing

import java.util.Random
import java.util.concurrent.CompletableFuture

/** How many times its reckoned bound a case is given: the room a scheduler's jitter takes. */
private const val SLACK = 4

/**
 * What one fresh run of a composition exposes to the liveness axioms, and how
 * it is ended. Each output completes when it has said something, a value or a
 * failure (L1); a live query's first state, pending, is nothing said. Each
 * settlement completes when its awaited path has settled, by returning or by
 * failing (L2). Closing it ends the composition.
 */
public class LivenessScenario @JvmOverloads constructor(
    public val outputs: List<CompletableFuture<*>>,
    public val settlements: List<CompletableFuture<*>>,
    private val end: AutoCloseable = AutoCloseable {},
) : AutoCloseable {
    override fun close(): Unit = end.close()
}

/**
 * A composition, and the schedules it is run under. `setup` builds a fresh
 * composition over the transport it is given; the scenario it gives is closed
 * when the case is over, and the transport after it. `timeoutMs` is the time
 * the composition gives a bus request, and the bound of a case is derived from
 * it: the timeout times one more than `retryBudget`, how often a logical
 * request may be sent again, and the schedule's delays, all of it four times
 * over. `respond` answers what nothing queued an answer for, as
 * `FaultyTransport`'s does.
 */
public class LivenessSpec @JvmOverloads constructor(
    public val setup: (FaultyTransport) -> LivenessScenario,
    public val timeoutMs: Long,
    public val retryBudget: Int,
    public val schedules: List<List<FaultAction>>,
    public val respond: Respond = REFUSE_UNSCRIPTED,
)

/** A wire behaviour, each as likely as the others: a delay is of 5 ms at most. */
public fun faultActions(random: Random): FaultAction = when (random.nextInt(5)) {
    0 -> Deliver
    1 -> DropReply
    2 -> Delay(random.nextInt(6).toLong())
    3 -> DuplicateReply
    else -> RejectEmit
}

/** `count` fault schedules, each of one to eight behaviours. */
public fun faultSchedules(count: Int, random: Random): List<List<FaultAction>> = List(count) { List(1 + random.nextInt(8)) { faultActions(random) } }

private fun described(schedule: List<FaultAction>): String = schedule.joinToString(",") { if (it is Delay) "delay(${it.ms})" else it.kind }

private fun livenessViolation(
    retryBudget: Int,
    boundMs: Long,
    schedule: List<FaultAction>,
    notified: List<Boolean>,
    settled: List<Boolean>,
    log: List<RequestLogEntry>,
): String? {
    val under = "under schedule ⟨${described(schedule)}⟩"
    // L2 first: where it applies it names the mechanism. L1 is the broader net, and would shadow it.
    settled.indexOf(false).takeIf { it >= 0 }?.let { return "L2: settlement #$it did not settle within ${boundMs}ms $under" }
    val sent = log.groupingBy { it.retryKey }.eachCount()
    val lastFaulted = log.associate { it.retryKey to (it.action == DropReply || it.action == RejectEmit) }
    val silent = true !in notified
    for ((key, times) in sent) {
        if (times > 1 + retryBudget) return "L2: request ⟨$key⟩ was sent $times times, past the retry budget (1 + $retryBudget) $under"
        if (lastFaulted.getValue(key) && times <= retryBudget && notified.isNotEmpty() && silent) {
            return "L2: faulted request ⟨$key⟩ was neither sent again nor surfaced $under: its failure was swallowed"
        }
    }
    notified.indexOf(false).takeIf { it >= 0 }?.let { return "L1: output #$it said nothing within ${boundMs}ms $under: silently pending" }
    return null
}

/**
 * The liveness axioms L1 and L2, run against a composition over a
 * `FaultyTransport` under each of the spec's schedules (docs: under any
 * behaviour of the wire, something is eventually said):
 *
 * - **L1** every output says something, a value or a failure, within the bound;
 * - **L2** every awaited path settles within the bound; a request is sent again
 *   no more often than its retry budget allows; and one whose last attempt was
 *   faulted is either sent again or surfaced, never swallowed.
 *
 * Each case runs on the real clock for the whole of its bound, however soon
 * everything has spoken, so a request sent again after that is counted: a
 * composition is given small timeouts. Throws an `AssertionError` naming the
 * first axiom broken, how, and under which schedule.
 */
public fun assertLivenessAxioms(spec: LivenessSpec) {
    for (schedule in spec.schedules) {
        val delays = schedule.filterIsInstance<Delay>().sumOf { it.ms }
        val boundMs = (spec.timeoutMs * (1 + spec.retryBudget) + delays) * SLACK
        val transport = FaultyTransport(schedule, spec.respond)
        val violation = try {
            spec.setup(transport).use { scenario ->
                Thread.sleep(boundMs)
                val notified = scenario.outputs.map { it.isDone }
                val settled = scenario.settlements.map { it.isDone }
                // What is still waiting is stopped before the composition is ended. What one threw is no axiom's business.
                (scenario.outputs + scenario.settlements).forEach { it.cancel(true) }
                livenessViolation(spec.retryBudget, boundMs, schedule, notified, settled, transport.requestLog)
            }
        } finally {
            transport.close()
        }
        violation?.let { throw AssertionError(it) }
    }
}

/** One step of an interleaving of writes and transitions. */
public enum class DeliveryOp(
    /** The step, as every SDK spells it. */
    public val wire: String,
) {
    WRITE("write"),
    TRANSITION("transition"),
}

/**
 * Something shaped like a connection: it accepts writes to whichever
 * connection is live, can be told to change connections, and delivers. A
 * model of one, or a real transport over real sockets. Closing it ends it.
 */
public interface DeliverySubject : AutoCloseable {
    /** Write the event with this id to the connection that is live now. */
    public fun write(eventId: String)

    /** Make a client-initiated transition: a handoff, a reopening, a change of scope. */
    public fun transition()

    /** Let whatever is in flight be delivered, then give the ids delivered, in order. */
    public fun delivered(): List<String>

    override fun close() {}
}

/** `count` interleavings of writes and transitions, each of one to `longest` steps, and each with a write: one that writes nothing checks nothing. */
public fun deliveryOps(count: Int, longest: Int, random: Random): List<List<DeliveryOp>> = List(count) {
    val steps = List(1 + random.nextInt(longest)) { if (random.nextBoolean()) DeliveryOp.WRITE else DeliveryOp.TRANSITION }
    if (DeliveryOp.WRITE in steps) steps else steps + DeliveryOp.WRITE
}

private fun deliveryViolation(ops: List<DeliveryOp>, written: List<String>, delivered: List<String>): String? {
    val under = "under ⟨${ops.joinToString(",") { it.wire }}⟩"
    for (eventId in written) {
        val times = delivered.count { it == eventId }
        if (times == 0) return "L3: event ⟨$eventId⟩ was delivered 0 times $under: lost across a transition"
        if (times > 1) return "L3: event ⟨$eventId⟩ was delivered $times times $under"
    }
    return null
}

/**
 * The liveness axiom L3, run against a fresh subject from `setup` for each of
 * `interleavings`: every event written to a live connection is delivered
 * exactly once, wherever a client-initiated transition lands relative to it,
 * so a connection is retired by drain, never by abort. Nothing settles between
 * steps: the races that matter are a transition landing before a write has
 * been delivered. Throws an `AssertionError` naming the event lost or doubled,
 * and the interleaving.
 */
public fun assertExactlyOnceDelivery(setup: () -> DeliverySubject, interleavings: List<List<DeliveryOp>>) {
    for (steps in interleavings) {
        val written = mutableListOf<String>()
        val violation = setup().use { subject ->
            for ((number, step) in steps.withIndex()) {
                when (step) {
                    DeliveryOp.WRITE -> "e$number".also { subject.write(it) }.let(written::add)
                    DeliveryOp.TRANSITION -> subject.transition()
                }
            }
            deliveryViolation(steps, written, subject.delivered())
        }
        violation?.let { throw AssertionError(it) }
    }
}
