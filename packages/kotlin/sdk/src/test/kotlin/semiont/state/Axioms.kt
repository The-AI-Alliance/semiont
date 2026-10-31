@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package semiont.state

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import semiont.ClientTiming
import semiont.Recording
import semiont.SemiontClient
import semiont.StateUnit
import kotlin.coroutines.CoroutineContext
import kotlin.random.Random
import kotlin.time.TimeSource

/** How many cases each property is tried on. */
private const val CASES = 30

/** A dependency a unit was given, as the axioms watch it: whether anything has ended it. */
internal fun interface Given {
    fun disposed(): Boolean
}

/** A stand-in for a dependency a unit is given: pass one to the unit and to `Fresh.given`, and the axioms check the unit never ended it. */
internal class DisposeProbe : StateUnit, Given {
    var disposals = 0

    override fun close() {
        disposals++
    }

    override fun disposed(): Boolean = disposals > 0
}

/** A freshly built unit, and what it was given. */
internal class Fresh<U : StateUnit>(val unit: U, val passedIn: List<Given> = emptyList()) {
    fun given(dependency: Given): Fresh<U> = Fresh(unit, passedIn + dependency)

    /** A client is ended when it is closed, and closing it ends its own bus. */
    fun given(client: SemiontClient): Fresh<U> = given(Given { client.bus.isDestroyed })
}

/** What a subject builds its units on: one case's clock, and the clients made on it, closed when the case ends. */
internal class Bench(val context: CoroutineContext, val clock: TimeSource) {
    private val made = mutableListOf<SemiontClient>()

    /** A client of its own, on the case's clock, over a transport that refuses every request. */
    fun client(): SemiontClient {
        val gateway = Recording()
        return SemiontClient(answering(Answers.REFUSES, null, context), gateway, gateway, ClientTiming(), null, context, clock).also { made += it }
    }

    fun close(): Unit = made.forEach { it.close() }
}

/**
 * How the axioms reach one kind of state unit. Only `setup` is required; a
 * means left as it is skips the axioms that need it, so a unit with no state
 * is held to no axiom about one.
 */
internal abstract class AxiomSubject<U : StateUnit> {
    /** Build a fresh unit, independent of every other, on the bench's clock. */
    abstract fun setup(bench: Bench): Fresh<U>

    /** A new reader of each state the unit hands out. */
    open fun surfaces(unit: U): List<Flow<*>> = emptyList()

    /** Each of the unit's methods, as a call with nothing to give it. */
    open fun invocations(unit: U): List<() -> Unit> = emptyList()

    /** A new reader of each state of the children the unit made itself. */
    open fun ownedChildSurfaces(unit: U): List<Flow<*>> = emptyList()

    /** Run the axioms against this subject's units. */
    fun keepsTheAxioms(): Unit = assertStateUnitAxioms(this)

    /** The class of unit this subject builds. */
    fun builds(bench: Bench): Class<*> = setup(bench).unit.also { it.close() }.javaClass
}

/** One reader of a state, as the axioms watch it: how much it was given since last asked, and whether it has ended. */
private class Reader(scope: CoroutineScope, surface: Flow<*>) {
    private var given = 0
    private var taken = 0
    var ended = false
        private set

    init {
        scope.launch {
            surface.collect { given++ }
            ended = true
        }
    }

    /** Take what is there now: how much there was. */
    fun drained(): Int = (given - taken).also { taken = given }
}

/** One case, on a scheduler of its own: what it found broken, or none. Its clients are closed when it ends. */
private fun case(axiom: String, body: TestScope.(Bench) -> String?) {
    var violation: String? = null
    try {
        runTest {
            val bench = Bench(StandardTestDispatcher(testScheduler), testScheduler.timeSource)
            try {
                violation = body(bench)
            } finally {
                bench.close()
                runCurrent()
            }
        }
    } catch (raised: Exception) {
        throw AssertionError("$axiom: the unit raised $raised", raised)
    }
    violation?.let { throw AssertionError("$axiom: $it") }
}

/** A property, tried on `CASES` values drawn from a fixed seed, so every run tries the same ones. */
private fun <T> property(axiom: String, draw: (Random) -> T, body: TestScope.(Bench, T) -> String?) {
    val random = Random(axiom.hashCode())
    repeat(CASES) {
        val value = draw(random)
        case(axiom) { bench -> body(bench, value)?.let { "$it (for $value)" } }
    }
}

private fun <U : StateUnit> undisposed(fresh: Fresh<U>, `when`: String): String? =
    fresh.passedIn.indexOfFirst { it.disposed() }.takeIf { it >= 0 }?.let { "the unit ended dependency #$it it was given $`when`" }

private fun drive(invocations: List<() -> Unit>, calls: List<Int>) {
    if (invocations.isEmpty()) return
    for (call in calls) invocations[call % invocations.size]()
}

/**
 * The state-unit axioms, run against fresh units `subject` builds, failing
 * with an `AssertionError` that names the first axiom a unit breaks, and how.
 *
 * - **X1** no state is a writer: a unit hands out a read-only reader of each
 *   state, never what holds it.
 * - **A7-passed** closing the unit does not end a dependency it was given: a
 *   `DisposeProbe` standing in for one, or the client itself.
 * - **A5** closing is idempotent and total: any number of calls, none
 *   throws, and none ends what the unit was given.
 * - **A6** every reader of a state taken before the close sees it end.
 * - **A5b** the unit is inert once closed: its methods do nothing, and a
 *   reader taken afterwards is given at most the value it held, and ends.
 * - **X3** instances are isolated: driving one never moves another's states.
 * - **A7-owned** closing the unit ends the states of the children it made.
 *
 * Each case runs on a test scheduler of its own, and before the harness looks
 * it lets what is ready run, so a unit that acts in a task of its own has
 * acted on what the harness did. No axiom waits on a timer.
 */
internal fun <U : StateUnit> assertStateUnitAxioms(subject: AxiomSubject<U>) {
    case("X1") { bench ->
        val fresh = subject.setup(bench)
        val writer = subject.surfaces(fresh.unit).indexOfFirst { it is MutableSharedFlow<*> || it is SendChannel<*> }
        fresh.unit.close()
        writer.takeIf { it >= 0 }?.let { "state #$it is what holds the state, which a reader could write" }
    }
    case("A7-passed") { bench ->
        val fresh = subject.setup(bench)
        fresh.unit.close()
        runCurrent()
        undisposed(fresh, "(it does not own it)")
    }
    property("A5", { it.nextInt(1, 21) }) { bench, calls ->
        val fresh = subject.setup(bench)
        repeat(calls) { fresh.unit.close() }
        runCurrent()
        undisposed(fresh, "under $calls closes")
    }
    var hasSurfaces = false
    case("A6") { bench ->
        val fresh = subject.setup(bench)
        hasSurfaces = subject.surfaces(fresh.unit).isNotEmpty()
        fresh.unit.close()
        null
    }
    if (hasSurfaces) {
        property("A6", { it.nextInt(1, 11) }) { bench, each ->
            val fresh = subject.setup(bench)
            val readers = List(each) { subject.surfaces(fresh.unit) }.flatten().map { Reader(backgroundScope, it) }
            runCurrent()
            readers.forEach { it.drained() }
            fresh.unit.close()
            runCurrent()
            readers.indexOfFirst { !it.ended }.takeIf { it >= 0 }?.let { "reader #$it of a state did not see it end on close ($each readers each)" }
        }
    }
    property("A5b", { random -> List(random.nextInt(0, 13)) { random.nextInt(0, 1000) } }) { bench, calls ->
        val fresh = subject.setup(bench)
        fresh.unit.close()
        drive(subject.invocations(fresh.unit), calls)
        runCurrent()
        subject.surfaces(fresh.unit).withIndex().firstNotNullOfOrNull { (number, surface) ->
            val reader = Reader(backgroundScope, surface)
            runCurrent()
            val given = reader.drained()
            when {
                given > 1 -> "state #$number, read after the close, gave $given values: more than the one it held"
                !reader.ended -> "state #$number, read after the close, has not ended"
                else -> null
            }
        }
    }
    property("X3", { random -> List(random.nextInt(1, 9)) { random.nextInt(0, 1000) } }) { bench, calls ->
        val one = subject.setup(bench)
        val other = subject.setup(bench)
        val watched = subject.surfaces(other.unit).map { Reader(backgroundScope, it) }
        runCurrent()
        watched.forEach { it.drained() }
        drive(subject.invocations(one.unit), calls)
        runCurrent()
        val moved = watched.indexOfFirst { it.drained() > 0 }
        one.unit.close()
        other.unit.close()
        moved.takeIf { it >= 0 }?.let { "driving one instance moved state #$it of another" }
    }
    case("A7-owned") { bench ->
        val fresh = subject.setup(bench)
        val children = subject.ownedChildSurfaces(fresh.unit).map { Reader(backgroundScope, it) }
        runCurrent()
        children.forEach { it.drained() }
        fresh.unit.close()
        runCurrent()
        children.indexOfFirst { !it.ended }.takeIf { it >= 0 }?.let { "the state #$it of a child the unit made did not end when the unit was closed" }
    }
}
