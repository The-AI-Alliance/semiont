@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.http

import semiont.bus.Logged
import semiont.bus.BusLog
import semiont.telemetry.futureOf
import semiont.telemetry.Telemetry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject
import semiont.Timings
import semiont.channels.BRIDGED_CHANNELS
import semiont.channels.RESOURCE_SCOPED_CHANNELS
import semiont.errors.SemiontError
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.identifiers.ResourceId
import semiont.retry.RetryFacts
import semiont.retry.RetryPolicy
import semiont.retry.BOOT
import semiont.retry.equalJitter
import semiont.retry.retryAfterMs
import semiont.transport.Broadcast
import semiont.transport.ConnectionState
import semiont.transport.Events
import semiont.transport.Frame
import semiont.transport.FrameSink
import semiont.transport.GatewayOperations
import semiont.transport.PendingReply
import semiont.transport.ReplyRouter
import semiont.transport.ResourceHold
import semiont.transport.Transport
import semiont.transport.Watched
import semiont.transport.unsubscribed
import semiont.types.BusEmitAccepted
import semiont.types.BusEmitRequest
import semiont.types.HealthResponse
import semiont.types.MediaTokenRequest
import semiont.types.MediaTokenResponse
import semiont.types.ProtectedResourceMetadata
import semiont.types.StatusResponse
import semiont.types.UserResponse
import semiont.types.wireJson
import java.io.IOException
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.HttpTimeoutException
import java.time.Duration
import java.util.UUID
import java.util.concurrent.CompletableFuture

/** The timing a transport keeps: specs/src/client/timing.json's, unless a caller that must not wait it out says otherwise. */
public data class Timing @JvmOverloads constructor(
    public val reconnectMs: Long = Timings.RECONNECT_MS,
    public val lazyRemoveMs: Long = Timings.LAZY_REMOVE_MS,
    public val lingerMs: Long = Timings.LINGER_MS,
    public val emitRetry: RetryPolicy = Timings.EMIT_RETRY,
    public val seenEventIdsCount: Int = Timings.SEEN_EVENT_IDS_COUNT.toInt(),
    /** The deadline on one request that is neither the stream nor an emit. */
    public val httpRequestMs: Long = Timings.HTTP_REQUEST_TIMEOUT_MS,
    /** The deadline on the gateway's answer to the request that opens the stream: its status and headers. */
    public val streamOpenMs: Long = Timings.STREAM_OPEN_TIMEOUT_MS,
)

/**
 * The bus over HTTP: emits to `POST /bus/emit`, and one stream from
 * `POST /bus/subscribe` (docs/protocol/TRANSPORT-HTTP.md). It reads its token
 * from `token`, which its owner feeds, and asks `refresher` for another when
 * the gateway refuses it. The stream opens once there is a token and
 * something to carry: a channel it names on no scope, or a resource's scope. With
 * `bookmarks`, each scope's stream begins where they say the client's last
 * life left it; with none, at the present. Every request, its stream's among
 * them, is made with `http`, and trusts what that client trusts; given none,
 * it makes its own, which keeps the JDK's default proxy selector and trust
 * store.
 */
public class HttpTransport @JvmOverloads constructor(
    baseUrl: String,
    private val token: StateFlow<String?>,
    /** The channels the stream names on no scope. */
    private val channels: List<String> = BRIDGED_CHANNELS,
    private val timing: Timing = Timing(),
    private val refresher: TokenRefresher? = null,
    bookmarks: Bookmarks? = null,
    private val http: HttpClient = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build(),
) : Transport, GatewayOperations {
    override val baseUrl: String = baseUrl.trimEnd('/')

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val clientId = UUID.randomUUID().toString()
    private val failureStream = Broadcast<SemiontError>(keepForFirst = true)
    private val hub = FrameHub()
    private val router = ReplyRouter()

    @Volatile
    private var closing = false
    internal val exchange = Exchange(this.baseUrl, http, token, refresher, failureStream, timing.httpRequestMs) { closing }
    private val stream = Stream(this.baseUrl, http, token, refresher, clientId, channels, timing, hub, router, failureStream, scope, bookmarks)
    private val holds = mutableMapOf<String, Int>()

    override val state: Watched<ConnectionState> = Watched(stream.state) { it == ConnectionState.Closed }

    init {
        stream.start()
    }

    // ── the bus ──────────────────────────────────────────────────────────

    override suspend fun emit(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): Long? {
        BusLog.line(Logged.EMIT, channel, payload, scope, correlationId)
        return Telemetry.emitting(channel, scope) { sent(channel, payload, scope, correlationId) }
    }

    /** One emit, made again inside the retry budget, its credential renewed once. */
    private suspend fun sent(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): Long? {
        val body = wireJson.encodeToString(
            BusEmitRequest.serializer(),
            BusEmitRequest(channel = channel, payload = payload, scope = scope, clientId = clientId, correlationId = correlationId),
        )
        var sent = token.value
        var renewed = false
        var made = 1
        var capMs = timing.emitRetry.initialDelayMs
        while (true) {
            if (closing) throw exchange.failed(TransportError(TransportErrorCode.Error, "/bus/emit was not sent: the transport is closed"))
            val request = exchange.request("/bus/emit", sent)
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .header("Content-Type", "application/json")
                .timeout(Duration.ofMillis(Timings.EMIT_TIMEOUT_MS))
                .build()
            val failure = try {
                val response = http.exchange(request, HttpResponse.BodyHandlers.ofByteArray())
                val status = response.statusCode()
                if (status in 200..299) return accepted(response.body())
                val stated = retryAfterMs(response.headers().firstValue("retry-after").orElse(null))
                refusal("/bus/emit $status: ${said(response.body()).orEmpty()}", status, response.body(), stated)
            } catch (_: HttpTimeoutException) {
                TransportError.withoutResponse("/bus/emit got no answer within ${Timings.EMIT_TIMEOUT_MS}ms")
            } catch (error: IOException) {
                TransportError.withoutResponse("/bus/emit got no answer: ${error.message ?: error::class.simpleName}")
            }
            if (failure.reason == TransportErrorCode.Unauthorized) {
                // A refused credential is renewed once, outside the retry budget, and never retried.
                if (!renewed && !closing) {
                    renewed = true
                    val another = exchange.renewal(sent)
                    if (another != null) {
                        sent = another
                        continue
                    }
                }
                throw exchange.failed(failure)
            }
            // A limit, a gateway that says it will recover, or no answer at all: made again inside the budget.
            val again = failure.status == null || BOOT.retryable(RetryFacts(failure.status, "POST"))
            if (!again || made >= timing.emitRetry.attempts || closing) throw exchange.failed(failure)
            delay(maxOf(equalJitter(capMs), failure.retryAfterMs ?: 0))
            capMs = minOf(capMs * 2, timing.emitRetry.maxDelayMs)
            made += 1
        }
    }

    private fun accepted(body: ByteArray): Long? =
        try {
            wireJson.decodeFromString(BusEmitAccepted.serializer(), body.toString(Charsets.UTF_8)).subscribers
        } catch (_: SerializationException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }

    @JvmExposeBoxed
    override fun emitFuture(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): CompletableFuture<Long?> =
        this.scope.futureOf { emit(channel, payload, scope, correlationId) }

    override fun frames(channel: String): Events<Frame> {
        if (channel !in channels && channel !in RESOURCE_SCOPED_CHANNELS) throw unsubscribed(channel)
        return hub.frames(channel)
    }

    override fun isSubscribed(channel: String): Boolean = channel in channels

    @JvmExposeBoxed
    override fun subscribeToResource(resourceId: ResourceId): ResourceHold {
        val first = synchronized(holds) {
            val held = holds.getOrDefault(resourceId.value, 0)
            holds[resourceId.value] = held + 1
            held == 0
        }
        if (first) stream.takeScope(resourceId)
        return ResourceHold {
            val last = synchronized(holds) {
                val held = holds.getOrDefault(resourceId.value, 0) - 1
                if (held <= 0) holds.remove(resourceId.value) else holds[resourceId.value] = held
                held <= 0
            }
            if (last) stream.letGoOfScope(resourceId)
        }
    }

    override fun failures(): Events<SemiontError> = failureStream.listen()

    override fun bridgeInto(bus: FrameSink): Unit = hub.bridge(bus)

    override fun trackReply(correlationId: String, replyChannels: Collection<String>): PendingReply = router.track(correlationId, replyChannels)

    override fun close() {
        if (closing) return
        closing = true
        stream.stop()
        failureStream.close()
        scope.cancel()
    }

    // ── the gateway's own operations ─────────────────────────────────────

    override suspend fun getCurrentUser(): UserResponse = exchange.answer(UserResponse.serializer(), "GET", "/api/users/me")

    override fun getCurrentUserFuture(): CompletableFuture<UserResponse> = scope.futureOf { getCurrentUser() }

    override suspend fun getMediaToken(resourceId: ResourceId): MediaTokenResponse {
        val body = wireJson.encodeToString(MediaTokenRequest.serializer(), MediaTokenRequest(resourceId = resourceId))
        return exchange.answer(MediaTokenResponse.serializer(), "POST", "/api/tokens/media", headers = mapOf("Content-Type" to "application/json"), body = { HttpRequest.BodyPublishers.ofString(body) })
    }

    @JvmExposeBoxed
    override fun getMediaTokenFuture(resourceId: ResourceId): CompletableFuture<MediaTokenResponse> = scope.futureOf { getMediaToken(resourceId) }

    override suspend fun getProtectedResourceMetadata(): ProtectedResourceMetadata =
        exchange.answer(ProtectedResourceMetadata.serializer(), "GET", "/.well-known/oauth-protected-resource", authenticated = false)

    override fun getProtectedResourceMetadataFuture(): CompletableFuture<ProtectedResourceMetadata> = scope.futureOf { getProtectedResourceMetadata() }

    override suspend fun healthCheck(): HealthResponse = exchange.answer(HealthResponse.serializer(), "GET", "/api/health")

    override fun healthCheckFuture(): CompletableFuture<HealthResponse> = scope.futureOf { healthCheck() }

    override suspend fun getStatus(): StatusResponse = exchange.answer(StatusResponse.serializer(), "GET", "/api/status")

    override fun getStatusFuture(): CompletableFuture<StatusResponse> = scope.futureOf { getStatus() }
}
