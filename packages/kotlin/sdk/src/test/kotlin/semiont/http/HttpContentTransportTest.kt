package semiont.http

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import semiont.Timings
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.identifiers.ResourceId
import semiont.transport.PutBinaryRequest
import semiont.types.CreateResourceResponse
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.ConcurrentLinkedDeque
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors

/** What the gateway does with one attempt at an upload, once it has read it whole. */
private sealed interface UploadReply

/** It answers `status`, with `body`. */
private class Answered(val status: Int, val body: String) : UploadReply

/** It closes the connection and answers nothing. */
private data object Unanswered : UploadReply

/** It answers nothing, and holds the connection until the gateway closes. */
private data object Held : UploadReply

/** One attempt at `POST /resources` as the gateway read it: the key it carried, and its bytes. */
private class UploadAttempt(val key: String?, val body: ByteArray)

/** A gateway that takes uploads: it reads each attempt whole, keeps it, and replies as the test scripted, in order. */
private class UploadGateway(vararg replies: UploadReply) : AutoCloseable {
    private val script = ConcurrentLinkedDeque(replies.toList())
    private val handling = Executors.newCachedThreadPool()
    private val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
    private val closing = CountDownLatch(1)
    val origin: String = "http://127.0.0.1:${server.address.port}"
    val attempts = CopyOnWriteArrayList<UploadAttempt>()

    init {
        server.createContext("/resources") { exchange ->
            attempts += UploadAttempt(exchange.requestHeaders.getFirst("Idempotency-Key"), exchange.requestBody.readAllBytes())
            when (val reply = checkNotNull(script.pollFirst()) { "attempt ${attempts.size} at the upload was not scripted" }) {
                is Answered -> answer(exchange, reply)
                // Closed before any response was begun, the exchange closes its connection.
                Unanswered -> exchange.close()
                Held -> closing.await()
            }
        }
        // Each attempt on a thread of its own: one held does not keep the next from being read.
        server.executor = handling
        server.start()
    }

    private fun answer(exchange: HttpExchange, reply: Answered) {
        val body = reply.body.toByteArray()
        exchange.responseHeaders.add("Content-Type", "application/json")
        exchange.sendResponseHeaders(reply.status, body.size.toLong())
        exchange.responseBody.write(body)
        exchange.close()
    }

    /** Two attempts, as one: under one key, and with the same bytes. */
    fun sentTwiceAsOne() {
        assertEquals(2, attempts.size)
        val (first, second) = attempts
        assertNotNull(first.key)
        assertEquals(first.key, second.key)
        assertArrayEquals(first.body, second.body)
    }

    override fun close() {
        closing.countDown()
        server.stop(0)
        handling.shutdownNow()
    }
}

private const val CREATED = """{"resourceId":"res-2"}"""

private val request = PutBinaryRequest(name = "a.txt", file = "the words".toByteArray(), format = "text/plain", storageUri = "file://a.txt")

/** An upload sent once more under its key, when its attempt failed in a way a repeat cannot make worse; and never when it was refused or given up. */
class HttpContentTransportTest {
    /** The resource an upload through `gateway` created. */
    private suspend fun uploaded(gateway: UploadGateway): CreateResourceResponse =
        HttpTransport(gateway.origin, MutableStateFlow("token"), emptyList()).use { transport ->
            HttpContentTransport(transport).use { content ->
                withTimeout(10_000) { content.putBinary(request).use { it.await() } }
            }
        }

    @Test
    fun anUploadAnswered503IsSentOnceMoreUnderItsKeyAndResolves() = runBlocking {
        UploadGateway(Answered(503, """{"error":"not now"}"""), Answered(202, CREATED)).use { gateway ->
            assertEquals(ResourceId("res-2"), uploaded(gateway).resourceId)
            gateway.sentTwiceAsOne()
        }
    }

    @Test
    fun anUploadThatGotNoAnswerIsSentOnceMoreUnderItsKeyAndResolves() = runBlocking {
        UploadGateway(Unanswered, Answered(202, CREATED)).use { gateway ->
            assertEquals(ResourceId("res-2"), uploaded(gateway).resourceId)
            gateway.sentTwiceAsOne()
        }
    }

    /** What an upload the gateway refuses with `status` fails with, once the gateway has been asked only once. */
    private fun refused(status: Int): TransportError =
        UploadGateway(Answered(status, """{"error":"refused"}""")).use { gateway ->
            val failure = assertThrows(TransportError::class.java) { runBlocking { uploaded(gateway) } }
            assertEquals(1, gateway.attempts.size)
            failure
        }

    @Test
    fun anUploadRefused400IsNotSentAgain() {
        assertEquals(TransportErrorCode.BadRequest, refused(400).reason)
    }

    @Test
    fun anUploadRefused422IsNotSentAgain() {
        assertEquals(TransportErrorCode.Unprocessable, refused(422).reason)
    }

    @Test
    fun aCancelledUploadIsNotSentAgain() = runBlocking {
        UploadGateway(Held).use { gateway ->
            HttpTransport(gateway.origin, MutableStateFlow("token"), emptyList()).use { transport ->
                HttpContentTransport(transport).use { content ->
                    val upload = content.putBinary(request)
                    withTimeout(10_000) {
                        while (gateway.attempts.isEmpty()) delay(5)
                    }
                    upload.close()
                    assertThrows(CancellationException::class.java) { runBlocking { upload.await() } }
                    // Longer than the pause before a resend.
                    delay(Timings.REQUEST_RETRY_PAUSE_MS * 3)
                    assertEquals(1, gateway.attempts.size)
                }
            }
        }
    }
}
