package semiont.http

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import semiont.transport.Events
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/** A gateway of one stream at a time: it keeps what each subscribe asked, holds the latest stream open, and writes there what a test gives it. */
internal class StreamGateway : AutoCloseable {
    private val handling = Executors.newCachedThreadPool()
    private val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
    val subscriptions = CopyOnWriteArrayList<JsonObject>()

    @Volatile
    private var stream = CompletableFuture<OutputStream>()

    init {
        server.createContext("/bus/subscribe") { exchange ->
            subscriptions += Json.parseToJsonElement(String(exchange.requestBody.readAllBytes())).jsonObject
            exchange.responseHeaders.add("Content-Type", "text/event-stream")
            exchange.sendResponseHeaders(200, 0)
            val out = exchange.responseBody
            out.write(": open\n\n".toByteArray())
            out.flush()
            stream.complete(out)
            stream = CompletableFuture<OutputStream>().also { it.complete(out) }
        }
        server.executor = handling
        server.start()
    }

    val origin: String get() = "http://127.0.0.1:${server.address.port}"

    /** A `bus-event` whose `data` line is `data`, a frame or not. */
    fun send(id: String, data: String) {
        val out = stream.get()
        synchronized(out) {
            out.write("id: $id\nevent: bus-event\ndata: $data\n\n".toByteArray())
            out.flush()
        }
    }

    /** Where a subscription of `scopes` scopes asks each to begin, once the gateway has been sent one. */
    suspend fun placesAskedFrom(scopes: Int): Map<String, String?> = withTimeout(5_000) {
        var found: Map<String, String?>? = null
        while (found == null) {
            found = subscriptions.reversed().firstNotNullOfOrNull { subscription ->
                (subscription["scoped"] as? JsonArray)?.takeIf { it.size == scopes }?.associate { entry ->
                    val stated = entry.jsonObject
                    stated.getValue("scope").jsonPrimitive.content to stated["lastEventId"]?.jsonPrimitive?.contentOrNull
                }
            }
            if (found == null) delay(5)
        }
        found
    }

    override fun close() {
        server.stop(0)
        handling.shutdownNow()
    }
}

/** The first `count` events read. */
internal suspend fun <T : Any> Events<T>.firstOf(count: Int): List<T> {
    val read = mutableListOf<T>()
    collect {
        read += it
        if (read.size == count) close()
    }
    return read
}
