package semiont.http

import semiont.telemetry.Telemetry
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.jdk9.asFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import semiont.Timings
import semiont.errors.SemiontError
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.retry.RetryFacts
import semiont.retry.RetryRules
import semiont.retry.retryAfterMs
import semiont.transport.Broadcast
import semiont.types.ErrorResponse
import semiont.types.LimitRefusal
import semiont.types.LimitRefusalCode
import semiont.types.wireJson
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.HttpTimeoutException
import java.nio.ByteBuffer
import java.time.Duration
import java.util.concurrent.CompletionException
import java.util.concurrent.Flow.Publisher
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * `request`'s response, once its head has come. Cancelled, it aborts the
 * exchange: the JDK's client closes the connection of a request it is sending
 * only when its future is cancelled with `mayInterruptIfRunning`.
 */
internal suspend fun <T> HttpClient.exchange(request: HttpRequest, handler: HttpResponse.BodyHandler<T>): HttpResponse<T> {
    val sending = sendAsync(request, handler)
    return suspendCancellableCoroutine { waiting ->
        waiting.invokeOnCancellation { sending.cancel(true) }
        sending.whenComplete { response, error ->
            if (error == null) waiting.resume(response) else waiting.resumeWithException((error as? CompletionException)?.cause ?: error)
        }
    }
}

/**
 * How a transport renews its token when the gateway refuses the one it has:
 * renew it at its source, make it the transport's token, and say what it is
 * now; null when it could not be renewed. `refused` is the token refused. It
 * is asked once per outage when the stream's credential is refused, and once
 * per request or emit whose credential is refused.
 */
public interface TokenRefresher {
    public suspend fun refresh(refused: String?): String?
}

/** A response whose body arrives as it is read. */
internal typealias Arriving = HttpResponse<Publisher<List<ByteBuffer>>>

/** Every byte of `body`. */
internal suspend fun readAll(body: Publisher<List<ByteBuffer>>): ByteArray {
    val out = ByteArrayOutputStream()
    body.asFlow().collect { buffers ->
        for (buffer in buffers) {
            val bytes = ByteArray(buffer.remaining())
            buffer.get(bytes)
            out.write(bytes)
        }
    }
    return out.toByteArray()
}

/**
 * The gateway's refusal of a request, under the code it fails with. A refused
 * credential (docs/protocol/TRANSPORT-CONTRACT.md, A refused credential) is
 * `unauthorized`: a 401, or a 429 whose body is a `LimitRefusal` naming
 * `refusal-rate`. Its token is renewed, never retried.
 */
internal fun refusal(message: String, status: Int, body: ByteArray?, statedWaitMs: Long?): TransportError =
    if (status == 401 || (status == 429 && body != null && namesRefusalRate(body))) {
        TransportError(TransportErrorCode.Unauthorized, message, status, statedWaitMs)
    } else {
        TransportError.ofStatus(message, status, statedWaitMs)
    }

private fun namesRefusalRate(body: ByteArray): Boolean =
    try {
        wireJson.decodeFromString(LimitRefusal.serializer(), body.toString(Charsets.UTF_8)).code == LimitRefusalCode.RefusalRate
    } catch (_: SerializationException) {
        // Not a limit this build can name: a limit all the same, as its status says.
        false
    } catch (_: IllegalArgumentException) {
        false
    }

/** The gateway's words for a refusal, when its body states them. */
internal fun said(body: ByteArray?, otherwise: String): String =
    try {
        body?.let { wireJson.decodeFromString(ErrorResponse.serializer(), it.toString(Charsets.UTF_8)).error } ?: otherwise
    } catch (_: SerializationException) {
        otherwise
    } catch (_: IllegalArgumentException) {
        otherwise
    }

/**
 * A transport's requests of its gateway that are neither its stream nor an
 * emit. A request carries the token the transport has now. One whose
 * credential is refused is made again at once, once its refresher has given
 * a token other than the one refused. Otherwise it is made a second time when
 * that is worth it and safe (the `transport` retry rule). A request whose
 * answer has not begun by its deadline fails as one that got no answer, and is
 * not made again. Every failure is reported on the transport's error stream as
 * it is raised to its caller.
 */
internal class Exchange(
    private val baseUrl: String,
    private val http: HttpClient,
    private val token: StateFlow<String?>,
    private val refresher: TokenRefresher?,
    private val failures: Broadcast<SemiontError>,
    private val deadlineMs: Long,
    private val closing: () -> Boolean,
) {
    /** Report a failure on the error stream, and hand it back for its caller. */
    fun failed(error: TransportError): TransportError {
        failures.deliver(error)
        return error
    }

    /** The token to send again in place of `refused`: what the refresher gives, when it is another. */
    suspend fun renewal(refused: String?): String? {
        val renewed = try {
            refresher?.refresh(refused)
        } catch (_: SemiontError) {
            null
        }
        return renewed?.takeIf { it != refused }
    }

    fun request(path: String, token: String?): HttpRequest.Builder {
        val builder = HttpRequest.newBuilder(URI.create("$baseUrl$path"))
        if (token != null) builder.header("Authorization", "Bearer $token")
        Telemetry.headers().forEach { (name, value) -> builder.header(name, value) }
        return builder
    }

    /**
     * Make a request, and return its answer once it has begun, its body not
     * yet read. A refusal is read here and thrown. The answer is to begin
     * within the transport's deadline, unless the request is made `atLength`.
     */
    suspend fun begin(
        method: String,
        path: String,
        authenticated: Boolean = true,
        headers: Map<String, String> = emptyMap(),
        body: (() -> HttpRequest.BodyPublisher)? = null,
        atLength: Boolean = false,
    ): Arriving {
        val repeatable = RetryRules.transport(RetryFacts(503, method))
        var sent = if (authenticated) token.value else null
        var retried = false
        var renewed = false
        while (true) {
            if (closing()) throw failed(TransportError(TransportErrorCode.Error, "$method $path was not sent: the transport is closed"))
            val builder = request(path, sent).method(method, body?.invoke() ?: HttpRequest.BodyPublishers.noBody())
            headers.forEach { (name, value) -> builder.header(name, value) }
            if (!atLength) builder.timeout(Duration.ofMillis(deadlineMs))
            val response = try {
                http.exchange(builder.build(), HttpResponse.BodyHandlers.ofPublisher())
            } catch (_: HttpTimeoutException) {
                throw failed(TransportError.withoutResponse("$method $path got no answer within ${deadlineMs}ms"))
            } catch (error: IOException) {
                if (repeatable && !retried && !closing()) {
                    retried = true
                    delay(Timings.REQUEST_RETRY_PAUSE_MS)
                    continue
                }
                throw failed(TransportError.withoutResponse("$method $path got no answer: ${error.message ?: error::class.simpleName}"))
            }
            val status = response.statusCode()
            if (status in 200..299) return response
            val stated = retryAfterMs(response.headers().firstValue("retry-after").orElse(null))
            val read = try {
                readAll(response.body())
            } catch (_: IOException) {
                null
            }
            val refused = refusal(said(read, "HTTP $status"), status, read, stated)
            if (refused.reason == TransportErrorCode.Unauthorized) {
                if (authenticated && !renewed && !closing()) {
                    renewed = true
                    val another = renewal(sent)
                    if (another != null) {
                        sent = another
                        continue
                    }
                }
                throw failed(refused)
            }
            if (!retried && !closing() && RetryRules.transport(RetryFacts(status, method))) {
                retried = true
                delay(maxOf(Timings.REQUEST_RETRY_PAUSE_MS, stated ?: 0))
                continue
            }
            throw failed(refused)
        }
    }

    /** Make a request, and read its answer as `declared`, within the same deadline. */
    suspend fun <T> answer(
        declared: KSerializer<T>,
        method: String,
        path: String,
        authenticated: Boolean = true,
        headers: Map<String, String> = emptyMap(),
        body: (() -> HttpRequest.BodyPublisher)? = null,
        atLength: Boolean = false,
    ): T {
        val response = begin(method, path, authenticated, headers, body, atLength)
        val read = try {
            if (atLength) readAll(response.body()) else withTimeout(deadlineMs) { readAll(response.body()) }
        } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
            throw failed(TransportError.withoutResponse("$method $path got no answer within ${deadlineMs}ms"))
        } catch (error: IOException) {
            throw failed(TransportError.withoutResponse("$method $path ended before its answer did: ${error.message}"))
        }
        return try {
            wireJson.decodeFromString(declared, read.toString(Charsets.UTF_8))
        } catch (error: SerializationException) {
            throw failed(TransportError(TransportErrorCode.Error, "$method $path answered what is not a ${declared.descriptor.serialName}: ${error.message}"))
        } catch (error: IllegalArgumentException) {
            throw failed(TransportError(TransportErrorCode.Error, "$method $path answered what is not a ${declared.descriptor.serialName}: ${error.message}"))
        }
    }
}
