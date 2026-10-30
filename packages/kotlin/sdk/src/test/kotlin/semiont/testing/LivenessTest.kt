package semiont.testing

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.future.future
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import semiont.bus.Operations
import semiont.bus.request
import semiont.errors.SemiontError
import java.util.Random

private const val TIMEOUT_MS = 20L
private val READ = Operations.BROWSE_RESOURCE_REQUESTED
private val ASKING = JsonObject(mapOf("resourceId" to JsonPrimitive("r1")))

/** Every request answered with a reply that carries no response. */
private val ANSWERING = Respond { _, _ -> null }

private fun spec(schedules: List<List<FaultAction>>, setup: (FaultyTransport) -> LivenessScenario) = LivenessSpec(setup, TIMEOUT_MS, 1, schedules, ANSWERING)

/** A composition's work, ended with its scenario. */
private fun scenario(outputs: (CoroutineScope) -> List<java.util.concurrent.CompletableFuture<*>>, settlements: (CoroutineScope) -> List<java.util.concurrent.CompletableFuture<*>>): LivenessScenario {
    val work = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    return LivenessScenario(outputs(work), settlements(work)) { work.cancel() }
}

private fun violated(said: String, check: () -> Unit) {
    val caught = assertThrows<AssertionError>(check)
    assertTrue(caught.message!!.contains(said), caught.message)
}

/** A client's connections, each retired as `retire` says. */
private class Connections(private val retire: String) : DeliverySubject {
    private val received = mutableListOf<String>()
    private val delivered = mutableListOf<String>()

    override fun write(eventId: String) {
        received += eventId
    }

    override fun transition() {
        when (retire) {
            // What it had received and not delivered is delivered first.
            "drain" -> {
                delivered += received
                received.clear()
            }
            // It is dropped with whatever it had received.
            "abort" -> received.clear()
            // It is drained, and the next connection replays the same events.
            "replay" -> delivered += received
        }
    }

    override fun delivered(): List<String> {
        delivered += received
        received.clear()
        return delivered.toList()
    }
}

private fun delivery(retire: String) = assertExactlyOnceDelivery({ Connections(retire) }, listOf(listOf(DeliveryOp.WRITE, DeliveryOp.TRANSITION, DeliveryOp.WRITE)))

/** The liveness harness against compositions that keep its axioms and ones built to break each: an axiom nothing can fail holds nothing. */
class LivenessTest {
    @Test
    fun aRequestSettlesUnderEverySchedule() {
        assertLivenessAxioms(
            spec(faultSchedules(25, Random(7))) { transport ->
                scenario({ emptyList() }) { work ->
                    listOf(work.future { runCatching { request(transport, READ, ASKING, TIMEOUT_MS) } })
                }
            },
        )
    }

    @Test
    fun aWaitWithNoDeadlineBreaksL2() = violated("L2: settlement #0 did not settle") {
        assertLivenessAxioms(
            spec(listOf(listOf(DropReply))) { transport ->
                scenario({ emptyList() }) { work ->
                    listOf(
                        work.future {
                            val pending = transport.trackReply("cid", listOf(READ.result.name, READ.failure.name))
                            transport.emit(READ.request.name, ASKING, null, "cid")
                            pending.frame()
                        },
                    )
                }
            },
        )
    }

    @Test
    fun aRequestSentAgainPastItsBudgetBreaksL2() = violated("past the retry budget") {
        assertLivenessAxioms(
            spec(listOf(listOf(RejectEmit))) { transport ->
                scenario({ emptyList() }) { work ->
                    listOf(
                        work.future {
                            repeat(3) {
                                try {
                                    request(transport, READ, ASKING, TIMEOUT_MS)
                                    return@future
                                } catch (_: SemiontError) {
                                    // Sent again, past the budget.
                                }
                            }
                        },
                    )
                }
            },
        )
    }

    @Test
    fun aSwallowedFailureBreaksL2() = violated("its failure was swallowed") {
        assertLivenessAxioms(
            spec(listOf(listOf(RejectEmit))) { transport ->
                val said = CompletableDeferred<Unit>()
                scenario({ work ->
                    // The failure goes nowhere: the output is told only of success.
                    work.future { runCatching { request(transport, READ, ASKING, TIMEOUT_MS) }.onSuccess { said.complete(Unit) } }
                    listOf(work.future { said.await() })
                }) { emptyList() }
            },
        )
    }

    @Test
    fun anOutputThatSaysNothingBreaksL1() = violated("L1: output #0 said nothing") {
        assertLivenessAxioms(spec(listOf(listOf(Deliver))) { LivenessScenario(listOf(java.util.concurrent.CompletableFuture<Unit>())) })
    }

    @Test
    fun aConnectionRetiredByDrainDeliversOnce() {
        delivery("drain")
    }

    @Test
    fun aConnectionRetiredByAbortBreaksL3() = violated("delivered 0 times") { delivery("abort") }

    @Test
    fun anEventDeliveredByBothConnectionsBreaksL3() = violated("delivered 2 times") { delivery("replay") }

    @Test
    fun theGeneratedInterleavingsEachWriteAndTheSchedulesEachDoSomething() {
        val random = Random(11)
        assertTrue(deliveryOps(50, 12, random).all { DeliveryOp.WRITE in it && it.size <= 13 })
        assertTrue(faultSchedules(50, random).all { it.size in 1..8 && it.all { action -> action !is Delay || action.ms in 0..5 } })
    }
}
