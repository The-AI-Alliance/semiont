package semiont.http

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import semiont.identifiers.ResourceId
import semiont.transport.ConnectionState
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

/** A gateway that accepts every connection, reads the request line of each, and never answers. */
private class Silent : AutoCloseable {
    private val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
    val origin: String = "http://127.0.0.1:${server.localPort}"
    private val held = CopyOnWriteArrayList<Socket>()

    /** The request line of each connection, in the order they came. */
    val asked = CopyOnWriteArrayList<String>()

    init {
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val socket = try {
                    server.accept()
                } catch (_: IOException) {
                    break
                }
                held += socket
                thread(isDaemon = true) {
                    try {
                        socket.getInputStream().bufferedReader().readLine()?.let { asked += it }
                    } catch (_: IOException) {
                        // Closed with the gateway.
                    }
                }
            }
        }
    }

    override fun close() {
        server.close()
        held.forEach { it.close() }
    }
}

/** A transport's stream: opened once there is a token and something to carry. */
class HttpTransportTest {
    @Test
    fun aTransportThatCarriesNothingOpensNoStreamUntilAScopeGivesItSomething() = runBlocking {
        Realm().use { realm ->
            HttpTransport(realm.origin, MutableStateFlow("token"), emptyList(), Timing(reconnectMs = 10, lazyRemoveMs = 10, lingerMs = 10)).use { transport ->
                // Held only for the gateway's own operations, or to ask who a token is: no request of the bus.
                delay(300)
                assertEquals(emptyList<String>(), realm.of("/bus/subscribe").map { it.path })
                assertEquals(ConnectionState.Initial, transport.state.value)
                transport.subscribeToResource(ResourceId("res-1")).use {
                    withTimeout(5_000) {
                        while (realm.of("/bus/subscribe").isEmpty()) delay(5)
                    }
                }
            }
        }
    }

    @Test
    fun anOpenTheGatewayDoesNotAnswerHasFailedAtItsDeadlineAndTheStreamIsOpenedAgain() = runBlocking {
        Silent().use { gateway ->
            HttpTransport(gateway.origin, MutableStateFlow("token"), emptyList(), Timing(reconnectMs = 10, lazyRemoveMs = 10, lingerMs = 10, streamOpenMs = 200)).use { transport ->
                transport.subscribeToResource(ResourceId("res-1")).use {
                    withTimeout(5_000) {
                        while (gateway.asked.size < 2) delay(5)
                    }
                    assertEquals(listOf("POST /bus/subscribe HTTP/1.1", "POST /bus/subscribe HTTP/1.1"), gateway.asked.take(2))
                }
            }
        }
    }
}
