package semiont.http

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import semiont.errors.SemiontError
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

/**
 * A gateway that answers every request with `answer`, written as it is, and
 * says nothing more: each connection is held until the gateway is closed, so
 * what the answer's head says of its body is all the client goes by.
 */
private class Answering(private val answer: String) : AutoCloseable {
    private val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
    val origin: String = "http://127.0.0.1:${server.localPort}"
    private val held = CopyOnWriteArrayList<Socket>()

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
                        val reader = socket.getInputStream().bufferedReader()
                        while (reader.readLine()?.isNotEmpty() == true) {
                            // The request's head: what it asks is answered the same way whatever it is.
                        }
                        socket.getOutputStream().apply {
                            write(answer.toByteArray())
                            flush()
                        }
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

/** A refusal with status 503, its body `body`. */
private fun unavailable(body: String): String =
    "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n$body"

/** A transport's stream: opened once there is a token and something to carry; and the client it makes every request with. */
class HttpTransportTest {
    @Test
    fun aTransportGivenItsCallersClientMakesItsStreamItsEmitsAndItsRequestsWithIt() = runBlocking {
        Realm().use { realm ->
            val http = CallersHttp()
            HttpTransport(realm.origin, MutableStateFlow("token"), listOf("browse:kb-result"), http = http).use { transport ->
                withTimeout(5_000) {
                    while (realm.of("/bus/subscribe").isEmpty()) delay(5)
                }
                transport.emit("browse:kb-requested", JsonObject(emptyMap()), null, "c-1")
                transport.getProtectedResourceMetadata()
            }
            assertTrue(http.made.containsAll(listOf("/bus/subscribe", "/bus/emit", "/.well-known/oauth-protected-resource")), "${http.made}")
            realm.askedOnlyThrough(http)
        }
    }

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

    /** What the transport reports of the stream's first refused open, through `gateway`. */
    private suspend fun firstRefusal(gateway: String): SemiontError =
        HttpTransport(gateway, MutableStateFlow("token"), emptyList(), Timing(reconnectMs = 10, lazyRemoveMs = 10, lingerMs = 10)).use { transport ->
            transport.subscribeToResource(ResourceId("res-1")).use {
                withTimeout(5_000) { transport.failures().use { it.first() } }
            }
        }

    @Test
    fun aRefusedOpenIsReportedInTheGatewaysWords() = runBlocking {
        Answering(unavailable("""{"error":"the gateway is draining"}""")).use { gateway ->
            assertEquals("SSE connect failed: 503: the gateway is draining", firstRefusal(gateway.origin).message)
        }
    }

    @Test
    fun aRefusedOpenWhoseBodySaysNothingIsReportedByItsStatus() = runBlocking {
        Answering(unavailable("")).use { gateway ->
            assertEquals("SSE connect failed: 503", firstRefusal(gateway.origin).message)
        }
    }
}
