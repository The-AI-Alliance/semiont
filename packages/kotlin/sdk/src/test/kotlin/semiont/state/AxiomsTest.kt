package semiont.state

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import org.junit.jupiter.api.assertThrows
import semiont.StateUnit
import semiont.transport.Variable

/** A unit that keeps every axiom: it holds a count a reader watches, is given a dependency it does not own, and makes a child it does. Each kind below breaks one. */
private open class Counter(protected val given: DisposeProbe, val child: Counter?) : StateUnit {
    protected var counting = Variable(0)
    protected var closed = false

    open val count: Flow<Int> get() = counting.reading()

    open fun increment() {
        if (!closed) counting.set(counting.value + 1)
    }

    override fun close() {
        closed = true
        counting.end()
        child?.close()
    }
}

private class GivesBackWhatItWasGiven(given: DisposeProbe, child: Counter?) : Counter(given, child) {
    override fun close() {
        super.close()
        given.close()
    }
}

private class FailsTheSecondTime(given: DisposeProbe, child: Counter?) : Counter(given, child) {
    override fun close() {
        check(!closed) { "closed twice" }
        super.close()
    }
}

private class NeverEndsItsCount(given: DisposeProbe, child: Counter?) : Counter(given, child) {
    override fun close() {
        closed = true
        child?.close()
    }
}

private class CountsAgainOnceClosed(given: DisposeProbe, child: Counter?) : Counter(given, child) {
    override fun increment() {
        // Once its count has ended, it starts another: a reader taken now is given a count that moves.
        if (closed) counting = Variable(counting.value + 1) else super.increment()
    }
}

/** Every one of its kind counts in one place. */
private val SHARED = mutableListOf<Variable<Int>>()

private class MovesTheOthers(given: DisposeProbe, child: Counter?) : Counter(given, child) {
    init {
        SHARED += counting
    }

    override fun increment() {
        SHARED.forEach { it.set(it.value + 1) }
    }
}

private class LeavesItsChild(given: DisposeProbe, child: Counter?) : Counter(given, child) {
    override fun close() {
        closed = true
        counting.end()
    }
}

private class HandsOutItsWriter(given: DisposeProbe, child: Counter?) : Counter(given, child) {
    private val writer = MutableStateFlow(0)

    override val count: Flow<Int> get() = writer
}

/** How the harness reaches a counter of one kind. */
private class Counters(private val make: (DisposeProbe, Counter?) -> Counter) : AxiomSubject<Counter>() {
    override fun setup(bench: Bench): Fresh<Counter> {
        val given = DisposeProbe()
        return Fresh(make(given, Counter(DisposeProbe(), null))).given(given)
    }

    override fun surfaces(unit: Counter): List<Flow<*>> = listOf(unit.count)

    override fun invocations(unit: Counter): List<() -> Unit> = listOf(unit::increment)

    override fun ownedChildSurfaces(unit: Counter): List<Flow<*>> = listOfNotNull(unit.child?.count)
}

/** The axiom harness, held to its own word: a unit broken against one axiom is caught under that axiom's name, and one broken against none passes. */
class AxiomsTest {
    @Test
    fun aCounterThatBreaksNoAxiomKeepsThemAll() {
        assertStateUnitAxioms(Counters(::Counter))
    }

    @TestFactory
    fun aUnitThatBreaksOneAxiomIsCaughtUnderItsName(): List<DynamicTest> = listOf(
        "A7-passed" to ::GivesBackWhatItWasGiven,
        "A5" to ::FailsTheSecondTime,
        "A6" to ::NeverEndsItsCount,
        "A5b" to ::CountsAgainOnceClosed,
        "X3" to ::MovesTheOthers,
        "A7-owned" to ::LeavesItsChild,
        "X1" to ::HandsOutItsWriter,
    ).map { (axiom, kind) ->
        DynamicTest.dynamicTest(axiom) {
            val caught = assertThrows<AssertionError> { assertStateUnitAxioms(Counters(kind)) }
            assertTrue(caught.message!!.startsWith("$axiom: "), caught.message)
        }
    }
}
