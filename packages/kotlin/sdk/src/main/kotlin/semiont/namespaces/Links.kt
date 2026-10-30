package semiont.namespaces

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import semiont.ClientTiming
import semiont.bus.Bus
import semiont.bus.EventBus
import semiont.bus.Operation
import semiont.channels.Channel
import semiont.errors.SemiontError
import semiont.telemetry.callersTrace
import semiont.telemetry.futureOf
import semiont.transport.Transport
import java.util.concurrent.CompletableFuture

/** What every namespace reaches the knowledge base through: the client's transport, the bus over it, the client's own bus, the waits it keeps, and the work it runs. */
internal class Links(val transport: Transport, val wire: Bus, val own: EventBus, val timing: ClientTiming) {
    /** The client's work: what is running when the client closes ends with it. */
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** A request of `operation`, within the client's deadline. */
    suspend fun <Q, R, F> request(operation: Operation<Q, R, F>, payload: Q): R = wire.request(operation, payload, timing.busRequestMs)

    /** A drive at the other participants: one frame over the wire, and how many of them the gateway reached. */
    suspend fun <P> drive(channel: Channel<P>, payload: P): Long? = wire.emit(channel, payload)

    /** A signal to this client's own parts. It never reaches the wire. */
    fun <P> signal(channel: Channel<P>, payload: P, correlationId: String? = null): Unit = own.publish(channel, payload, null, correlationId)

    /** A report over the wire that nobody awaits: a failure of it is heard where the transport tells its failures. */
    fun <P> report(channel: Channel<P>, payload: P) {
        scope.launch(callersTrace()) {
            try {
                wire.emit(channel, payload)
            } catch (_: SemiontError) {
                // The transport has told it.
            }
        }
    }

    /** `work` as a future, for Java: a task of the client's. */
    fun <T> future(work: suspend () -> T): CompletableFuture<T> = scope.futureOf(work)

    /** End every task begun here that has not ended by itself. */
    fun close(): Unit = scope.cancel()
}
