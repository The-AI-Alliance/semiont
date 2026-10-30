package semiont.http

import semiont.Timings
import semiont.discovery.Absent
import semiont.discovery.DiscoveryAbsentReason
import semiont.discovery.DiscoveryRead
import semiont.discovery.DiscoveryTransport
import semiont.discovery.Managed
import semiont.discovery.Unchanged
import semiont.discovery.parseDiscoveryDocument
import java.io.IOException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.HttpTimeoutException
import java.time.Duration

/** A transport that reads the discovery document at `url`, each read within `deadlineMs`. */
private class HttpDiscovery(private val url: String, private val deadlineMs: Long) : DiscoveryTransport {
    private val http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).followRedirects(HttpClient.Redirect.NORMAL).build()

    /** The tag of the last document that read as managed; null when that document had none, or none has. */
    @Volatile
    private var tag: String? = null

    override suspend fun read(): DiscoveryRead {
        val asked = HttpRequest.newBuilder(URI.create(url)).GET().timeout(Duration.ofMillis(deadlineMs))
        tag?.let { asked.header("If-None-Match", it) }
        val response = try {
            http.exchange(asked.build(), HttpResponse.BodyHandlers.ofString())
        } catch (_: HttpTimeoutException) {
            return Absent(DiscoveryAbsentReason.Unreadable, "the document was not served within ${deadlineMs}ms")
        } catch (unanswered: IOException) {
            return Absent(DiscoveryAbsentReason.Unreadable, unanswered.message ?: unanswered::class.java.simpleName)
        }
        val status = response.statusCode()
        if (status == 304) return Unchanged
        if (status !in 200..299) return Absent(DiscoveryAbsentReason.NotFound, "HTTP $status")
        val type = response.headers().firstValue("content-type").orElse("")
        if ("json" !in type.lowercase()) return Absent(DiscoveryAbsentReason.NotFound, "the content type is \"$type\", not JSON")
        val state = parseDiscoveryDocument(response.body())
        // Only a good document's tag is kept: one kept for a document that did not read would have this believe it for good.
        if (state is Managed) tag = response.headers().firstValue("etag").orElse(null)
        return state
    }
}

/** `httpDiscovery`, each read within `deadlineMs`. */
internal fun httpDiscovery(url: String, deadlineMs: Long): DiscoveryTransport = HttpDiscovery(url, deadlineMs)

/**
 * A transport that reads the discovery document at `url`, each read within
 * the timing table's request deadline. A redirect is followed. Its HTTP
 * client keeps the JDK's default proxy selector and trust store, and reads no
 * environment variable.
 */
public fun httpDiscovery(url: String): DiscoveryTransport = httpDiscovery(url, Timings.HTTP_REQUEST_TIMEOUT_MS)
