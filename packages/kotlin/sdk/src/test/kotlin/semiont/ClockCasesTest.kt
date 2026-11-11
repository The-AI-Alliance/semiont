@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package semiont

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import org.junit.jupiter.api.assertThrows
import semiont.bus.Operations
import semiont.bus.request
import semiont.cache.Cache
import semiont.cache.CachePersister
import semiont.channels.BRIDGED_CHANNELS
import semiont.cache.CacheRefreshTrigger
import semiont.discovery.DiscoveryRead
import semiont.discovery.DiscoveryTransport
import semiont.discovery.Managed
import semiont.discovery.Unchanged
import semiont.discovery.subscribeDiscovery
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode
import semiont.errors.TransportError
import semiont.http.HttpTransport
import semiont.http.signInDevice
import semiont.identifiers.JobId
import semiont.jobs.running
import semiont.live.KbWorld
import semiont.live.RESOURCE
import semiont.live.event
import semiont.retry.RetryPolicy
import semiont.session.SemiontSession
import semiont.session.TARGET
import semiont.session.alice
import semiont.session.token
import semiont.signin.HeldSignIn
import semiont.signin.MemorySignIn
import semiont.signin.SCRIPT_CLIENT_ID
import semiont.testing.FaultyTransport
import semiont.testing.REFUSE_UNSCRIPTED
import semiont.testing.Respond
import semiont.transport.ConnectionState
import semiont.transport.Frame
import semiont.transport.Watched
import semiont.types.DiscoveredKB
import semiont.types.HighlightingJobParams
import semiont.types.JobFilter
import semiont.types.JobProgress
import semiont.types.JobStatusResponse
import semiont.types.wireJson
import java.net.Authenticator
import java.net.CookieHandler
import java.net.ProxySelector
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpHeaders
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.ByteBuffer
import java.time.Duration
import java.util.Optional
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executor
import java.util.concurrent.Flow
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLParameters
import javax.net.ssl.SSLSession
import kotlin.random.Random
import kotlin.time.TimeSource

private val TABLE: JsonObject = Spec.read("client/clock-cases.json").jsonObject
private val CASES: List<JsonObject> = TABLE.getValue("cases").jsonArray.map { it.jsonObject }

private fun JsonElement.text(): String = jsonPrimitive.content

// ── Durations ───────────────────────────────────────────────────────────

/** A timing protocol/specs/src/client/timing.json names, as this SDK keeps it: a row, or a retry budget's member after a `.`. */
private fun timingMs(name: String): Long {
    val parts = name.split('.')
    val constant = parts[0].replace(Regex("(?<=[a-z0-9])(?=[A-Z])"), "_").uppercase()
    val kept = Timings::class.java.getDeclaredField(constant).apply { isAccessible = true }
    return when (parts.size) {
        1 -> kept.getLong(null)
        2 -> RetryPolicy::class.java.getMethod("get" + parts[1].replaceFirstChar(Char::uppercaseChar)).invoke(kept.get(null)) as Long
        else -> throw AssertionError("$name names no timing")
    }
}

/** A duration as the table states it: milliseconds, or a timing scaled by `times` and moved by `plusMs`, a whole number of milliseconds either way. */
private fun durationMs(value: JsonElement): Long {
    if (value is JsonPrimitive) return value.long
    val stated = value.jsonObject
    val scaled = timingMs(stated.getValue("timing").text()) * (stated["times"]?.jsonPrimitive?.double ?: 1.0) + (stated["plusMs"]?.jsonPrimitive?.long ?: 0)
    if (scaled != Math.floor(scaled)) throw AssertionError("$value is not a whole number of milliseconds")
    return scaled.toLong()
}

// ── Where a case is played ──────────────────────────────────────────────

/**
 * Where a case is played: a dispatcher on the test's scheduler, which every
 * subject is made with, the scheduler's clock, and the work the subject sets
 * going. What the subject holds is closed when the case ends, its work
 * cancelled first.
 */
private class Bench(val test: TestScope) {
    val context = StandardTestDispatcher(test.testScheduler)
    val clock: TimeSource = test.testScheduler.timeSource
    val work = CoroutineScope(SupervisorJob() + context)
    private val holding = mutableListOf<AutoCloseable>()

    fun <T : AutoCloseable> held(it: T): T = it.also { holding += it }

    fun close() {
        work.cancel()
        holding.asReversed().forEach { it.close() }
        test.runCurrent()
    }
}

/** A random source whose every draw is the lowest it can give: the equal jitter of a step is half the step. */
private object LowestDraw : Random() {
    override fun nextBits(bitCount: Int): Int = 0
}

/** What a case drives: what it counts, and its action, when it has one. */
private class Subject(val counted: () -> Int, val act: (suspend () -> Unit)?)

/** How many of the values `watched` takes, from the case's start, `counts` holds of. */
private fun <T> tally(bench: Bench, watched: Watched<T>, counts: (T) -> Boolean): () -> Int {
    var seen = 0
    bench.work.launch { watched.collect { if (counts(it)) seen += 1 } }
    return { seen }
}

// ── The network, in this process ────────────────────────────────────────

/** What the network answers a request with: a status, headers and a body. A body `heldOpen` never ends, and tells it when its reader closes it. */
private class Reply(val status: Int, val headers: Map<String, List<String>>, val body: String, val heldOpen: (() -> Unit)?)

private fun json(status: Int, body: JsonObject) = Reply(status, mapOf("content-type" to listOf("application/json")), body.toString(), null)

private class Info(private val reply: Reply) : HttpResponse.ResponseInfo {
    override fun statusCode(): Int = reply.status

    override fun headers(): HttpHeaders = HttpHeaders.of(reply.headers) { _, _ -> true }

    override fun version(): HttpClient.Version = HttpClient.Version.HTTP_1_1
}

/** A body as its reader takes it: all of it at the first ask, then its end; held open, nothing, until the reader closes it. */
private class Body(private val reader: Flow.Subscriber<List<ByteBuffer>>, private val reply: Reply) : Flow.Subscription {
    private var given = false
    private var closed = false

    override fun request(n: Long) {
        if (given || reply.heldOpen != null) return
        given = true
        if (reply.body.isNotEmpty()) reader.onNext(listOf(ByteBuffer.wrap(reply.body.toByteArray())))
        reader.onComplete()
    }

    override fun cancel() {
        val told = reply.heldOpen ?: return
        if (closed) return
        closed = true
        told()
    }
}

private class Response<T>(private val request: HttpRequest, private val info: Info, private val body: T) : HttpResponse<T> {
    override fun statusCode(): Int = info.statusCode()

    override fun request(): HttpRequest = request

    override fun previousResponse(): Optional<HttpResponse<T>> = Optional.empty()

    override fun headers(): HttpHeaders = info.headers()

    override fun body(): T = body

    override fun sslSession(): Optional<SSLSession> = Optional.empty()

    override fun uri(): URI = request.uri()

    override fun version(): HttpClient.Version = info.version()
}

/**
 * A network in this process: each request is answered at once, as `answer`
 * says, or never, when it says nothing. It opens no socket and starts no
 * thread, so it takes no time the test's clock does not give.
 */
private class Network(private val answer: (HttpRequest) -> Reply?) : HttpClient() {
    override fun <T> sendAsync(request: HttpRequest, handler: HttpResponse.BodyHandler<T>): CompletableFuture<HttpResponse<T>> {
        val reply = answer(request) ?: return CompletableFuture()
        val info = Info(reply)
        val reader = handler.apply(info)
        val read = reader.body.toCompletableFuture()
        reader.onSubscribe(Body(reader, reply))
        return read.thenApply<HttpResponse<T>> { Response(request, info, it) }
    }

    override fun <T> sendAsync(
        request: HttpRequest,
        handler: HttpResponse.BodyHandler<T>,
        pushPromiseHandler: HttpResponse.PushPromiseHandler<T>?,
    ): CompletableFuture<HttpResponse<T>> = sendAsync(request, handler)

    override fun <T> send(request: HttpRequest, handler: HttpResponse.BodyHandler<T>): HttpResponse<T> =
        throw AssertionError("the SDK sends every request asynchronously: no thread of it waits on the network")

    override fun cookieHandler(): Optional<CookieHandler> = Optional.empty()

    override fun connectTimeout(): Optional<Duration> = Optional.empty()

    override fun followRedirects(): HttpClient.Redirect = HttpClient.Redirect.NEVER

    override fun proxy(): Optional<ProxySelector> = Optional.empty()

    override fun sslContext(): SSLContext = SSLContext.getDefault()

    override fun sslParameters(): SSLParameters = SSLParameters()

    override fun authenticator(): Optional<Authenticator> = Optional.empty()

    override fun version(): HttpClient.Version = HttpClient.Version.HTTP_1_1

    override fun executor(): Optional<Executor> = Optional.empty()
}

// ── A gateway ───────────────────────────────────────────────────────────

private const val GATEWAY = "http://localhost:4000"
private const val SUBSCRIBE = "/bus/subscribe"
private const val EMIT = "/bus/emit"
private const val HEALTH = "/api/health"

/** How a gateway answers a subscribe: with a stream it holds open, with a 503, or never. */
private enum class Streams { HOLDS, REFUSES, NEVER }

/**
 * A gateway in this process. It answers a subscribe as `streams` says, refuses what `refused` names with a 503, never
 * answers what `unanswered` names, and counts what it is asked. Its refusals carry a `Retry-After` of
 * `retryAfterSeconds`, when it states one.
 */
private class Gateway(
    private val streams: Streams,
    private val retryAfterSeconds: Long?,
    private val unanswered: Set<String>,
    private val refused: Set<String> = emptySet(),
) {
    private val asked = mutableMapOf<String, Int>()

    /** How many of the streams it held open their readers have closed. */
    var closed = 0
        private set

    /** How many requests of `path` it has been asked. */
    fun asked(path: String): Int = asked.getOrDefault(path, 0)

    private fun answer(request: HttpRequest): Reply? {
        val path = request.uri().path
        asked.merge(path, 1, Int::plus)
        if (path in unanswered) return null
        if (path in refused) return refusal()
        if (path != SUBSCRIBE) throw AssertionError("the gateway was asked ${request.method()} $path, which this subject does not have it answer")
        return when (streams) {
            Streams.HOLDS -> Reply(200, mapOf("content-type" to listOf("text/event-stream")), "") { closed += 1 }
            Streams.REFUSES -> refusal()
            Streams.NEVER -> null
        }
    }

    private fun refusal() = Reply(
        503,
        if (retryAfterSeconds == null) mapOf("content-type" to listOf("application/json")) else mapOf("content-type" to listOf("application/json"), "retry-after" to listOf("$retryAfterSeconds")),
        """{"error":"The gateway is not ready"}""",
        null,
    )

    /** A transport to this gateway, holding a token, so its stream is set going. */
    fun transport(bench: Bench): HttpTransport = bench.held(
        HttpTransport(GATEWAY, MutableStateFlow<String?>("a-token"), BRIDGED_CHANNELS, http = Network(::answer), context = bench.context, clock = bench.clock, random = LowestDraw),
    )
}

private fun retryAfter(given: JsonObject): Long? = given["retryAfterSeconds"]?.jsonPrimitive?.long

private suspend fun refusedStream(given: JsonObject, bench: Bench): Subject {
    val gateway = Gateway(Streams.REFUSES, retryAfter(given), emptySet())
    gateway.transport(bench)
    return Subject({ gateway.asked(SUBSCRIBE) }, null)
}

private suspend fun unansweredStream(given: JsonObject, bench: Bench): Subject {
    val gateway = Gateway(Streams.NEVER, null, emptySet())
    gateway.transport(bench)
    return Subject({ gateway.asked(SUBSCRIBE) }, null)
}

private suspend fun degradedStream(given: JsonObject, bench: Bench): Subject {
    val transport = Gateway(Streams.REFUSES, retryAfter(given), emptySet()).transport(bench)
    return Subject(tally(bench, transport.state) { it == ConnectionState.Degraded }, null)
}

private suspend fun scopeTaken(given: JsonObject, bench: Bench): Subject {
    val gateway = Gateway(Streams.HOLDS, null, emptySet())
    val transport = gateway.transport(bench)
    return Subject({ gateway.asked(SUBSCRIBE) }, { bench.held(transport.subscribeToResource(RESOURCE)) })
}

private suspend fun scopeLetGo(given: JsonObject, bench: Bench): Subject {
    val gateway = Gateway(Streams.HOLDS, null, emptySet())
    val transport = gateway.transport(bench)
    bench.test.runCurrent()
    assertEquals(ConnectionState.Open, transport.state.value, "the stream opened")
    val hold = bench.held(transport.subscribeToResource(RESOURCE))
    return Subject({ gateway.asked(SUBSCRIBE) }, { hold.close() })
}

private suspend fun handoffLinger(given: JsonObject, bench: Bench): Subject {
    val gateway = Gateway(Streams.HOLDS, null, emptySet())
    val transport = gateway.transport(bench)
    return Subject({ gateway.closed }, { bench.held(transport.subscribeToResource(RESOURCE)) })
}

private suspend fun unansweredRequest(given: JsonObject, bench: Bench): Subject {
    val transport = Gateway(Streams.HOLDS, null, setOf(HEALTH)).transport(bench)
    val asked = bench.work.async { transport.healthCheck() }
    return Subject(
        {
            if (!asked.isCompleted) {
                0
            } else {
                val failure = asked.getCompletionExceptionOrNull()
                assertTrue(failure is TransportError && failure.status == null, "the health check ended otherwise: $failure")
                1
            }
        },
        null,
    )
}

private suspend fun unansweredEmit(given: JsonObject, bench: Bench): Subject {
    val gateway = Gateway(Streams.HOLDS, null, setOf(EMIT))
    val transport = gateway.transport(bench)
    // Its attempts are cut, with the subject's work, before the transport closes.
    bench.work.launch { transport.emit("beckon:hover", JsonObject(mapOf("annotationId" to JsonPrimitive("ann-1"))), null, null) }
    return Subject({ gateway.asked(EMIT) }, null)
}

/** A bus request of a resource's events, made as the case begins, over a gateway that holds its stream open and refuses every emit. */
private fun refusedRequest(given: JsonObject, bench: Bench): Pair<Gateway, Deferred<JsonObject>> {
    val gateway = Gateway(Streams.HOLDS, retryAfter(given), emptySet(), refused = setOf(EMIT))
    val transport = gateway.transport(bench)
    val payload = JsonObject(mapOf("resourceId" to JsonPrimitive(RESOURCE.value)))
    return gateway to bench.work.async { request(transport, Operations.BROWSE_EVENTS_REQUESTED, payload, clock = bench.clock) }
}

private suspend fun refusedBusRequest(given: JsonObject, bench: Bench): Subject {
    val (gateway, asked) = refusedRequest(given, bench)
    return Subject(
        {
            // How it fails is what timedOutBusRequest counts.
            assertTrue(!asked.isCompleted || asked.getCompletionExceptionOrNull() != null, "the request was answered")
            gateway.asked(EMIT)
        },
        null,
    )
}

private suspend fun timedOutBusRequest(given: JsonObject, bench: Bench): Subject {
    val (_, asked) = refusedRequest(given, bench)
    return Subject(
        {
            if (!asked.isCompleted) {
                0
            } else {
                val failure = asked.getCompletionExceptionOrNull()
                assertTrue(failure is BusRequestError && failure.reason == BusRequestErrorCode.Timeout, "the request ended otherwise: $failure")
                1
            }
        },
        null,
    )
}

// ── An issuer ───────────────────────────────────────────────────────────

private const val ISSUER = "http://issuer.test/realms/semiont"

/**
 * A knowledge base that trusts an issuer, and the issuer, in this process:
 * what a device grant asks. It mints a code that lives 900 seconds, with the
 * interval the case states, and answers each ask of its token endpoint with
 * the next of `answers`, the last repeating.
 */
private class Issuer(private val intervalSeconds: Long?, private val answers: List<String>) {
    var tokenAsks = 0
        private set

    fun answer(request: HttpRequest): Reply {
        val uri = request.uri()
        return when (val where = "${uri.scheme}://${uri.authority}${uri.path}") {
            "$GATEWAY/.well-known/oauth-protected-resource" -> json(200, buildJsonObject {
                put("resource", GATEWAY)
                put("authorization_servers", JsonArray(listOf(JsonPrimitive(ISSUER))))
                put("bearer_methods_supported", JsonArray(listOf(JsonPrimitive("header"))))
            })
            "$ISSUER/.well-known/openid-configuration" -> json(200, buildJsonObject {
                put("issuer", ISSUER)
                put("authorization_endpoint", "$ISSUER/auth")
                put("token_endpoint", "$ISSUER/token")
                put("device_authorization_endpoint", "$ISSUER/device")
            })
            "$ISSUER/device" -> json(200, buildJsonObject {
                put("device_code", "the-device-code")
                put("user_code", "WDJB-MJHT")
                put("verification_uri", "http://issuer.test/device")
                put("expires_in", 900)
                if (intervalSeconds != null) put("interval", intervalSeconds)
            })
            "$ISSUER/token" -> {
                val said = answers[minOf(tokenAsks, answers.lastIndex)]
                tokenAsks += 1
                json(400, buildJsonObject { put("error", said) })
            }
            else -> throw AssertionError("the issuer was asked ${request.method()} $where, which a device grant does not ask")
        }
    }
}

private suspend fun deviceGrant(given: JsonObject, bench: Bench): Subject {
    val issuer = Issuer(given["intervalSeconds"]?.jsonPrimitive?.long, given.getValue("answers").jsonArray.map { it.text() })
    bench.work.launch { signInDevice(TARGET, MemorySignIn(), Network(issuer::answer), bench.clock) {} }
    return Subject({ issuer.tokenAsks }, null)
}

// ── A session ───────────────────────────────────────────────────────────

private suspend fun renewal(given: JsonObject, bench: Bench): Subject {
    val lifetime = given.getValue("lifetimeSeconds").jsonPrimitive.long
    var renewals = 0
    val gateway = Recording()
    val client = bench.held(SemiontClient(gateway, gateway, gateway, ClientTiming(), null, bench.context, bench.clock))
    val kept = MemorySignIn(HeldSignIn(token(lifetime, 0), "a-refresh-token", SCRIPT_CLIENT_ID, "$ISSUER/token", null, null))
    val renew: suspend (String?) -> String? = {
        renewals += 1
        token(lifetime, renewals)
    }
    val session = bench.held(SemiontSession(TARGET, client, MutableStateFlow(null), kept, renew, { alice }, null, LowestDraw))
    session.start()
    return Subject({ renewals }, null)
}

// ── A worker's claims ───────────────────────────────────────────────────

private val MARK_JOBS: List<JobFilter> = wireJson.decodeFromString(ListSerializer(serializer<JobFilter>()), """[{"jobType":"mark","params":{"motivation":"highlighting"}}]""")

private suspend fun heldJobStall(given: JsonObject, bench: Bench): Subject {
    val dispatcher = Respond { operation, payload -> if (operation == "job:claim") running("job-1") else REFUSE_UNSCRIPTED.respond(operation, payload) }
    val transport = bench.held(FaultyTransport(emptyList(), dispatcher, null, bench.context))
    val gateway = Recording()
    val client = bench.held(SemiontClient(transport, gateway, gateway, ClientTiming(), null, bench.context, bench.clock))
    val claims = client.job.claim(MARK_JOBS)
    val claiming = bench.work.async { claims.next() }
    bench.test.runCurrent()
    val job = claiming.getCompleted() ?: throw AssertionError("the claims ended before they held a job")
    return Subject(tally(bench, claims.stalled) { it != null }, { job.progress(JobProgress(percentage = 50.0)) })
}

// ── Discovery ───────────────────────────────────────────────────────────

private val MANAGED = Managed(
    listOf(wireJson.decodeFromString(DiscoveredKB.serializer(), """{"host":"localhost","port":4000,"placement":"local","managedBy":"semiont-launcher","did":"did:web:example.org:kb-a"}""")),
)

/** A launcher's document: one managed knowledge base at the first read, and unchanged at every read after it. */
private class LauncherDocument : DiscoveryTransport {
    var reads = 0
        private set

    override suspend fun read(): DiscoveryRead {
        reads += 1
        return if (reads == 1) MANAGED else Unchanged
    }
}

private suspend fun discovery(given: JsonObject, bench: Bench): Subject {
    val document = LauncherDocument()
    val changes = bench.held(subscribeDiscovery(document, Timings.DISCOVERY_INTERVAL_MS))
    bench.work.launch { changes.collect {} }
    return Subject({ document.reads }, null)
}

// ── A client's queries and caches ───────────────────────────────────────

private suspend fun invalidationWindow(given: JsonObject, bench: Bench): Subject {
    val world = KbWorld(bench.context, bench.clock, Timings.INVALIDATION_WINDOW_MS)
    bench.held(AutoCloseable { world.close() })
    world.watch(world.client.browse.events(RESOURCE))
    return Subject({ world.kb.askedFor("browse:events-requested").size }, { world.kb.deliver(event(CacheRefreshTrigger.MarkAdded)) })
}

/** A cache's storage: it keeps nothing to begin with, and records each save. */
private class Saves : CachePersister<String, Int> {
    val saved = mutableListOf<Map<String, Int>>()

    override fun load(): Map<String, Int>? = null

    override fun save(entries: Map<String, Int>) {
        saved += entries
    }
}

private suspend fun saveDebounce(given: JsonObject, bench: Bench): Subject {
    val saves = Saves()
    val cache = bench.held(Cache<String, Int>({ key -> throw AssertionError("a cache that is only written fetched $key") }, saves, Timings.SAVE_DEBOUNCE_MS, bench.context))
    var changes = 0
    return Subject(
        { saves.saved.size },
        {
            changes += 1
            cache.set("a key", changes)
        },
    )
}

private val JOB_RUNNING: JsonElement =
    Json.parseToJsonElement("""{"jobId":"job-1","type":"mark","status":"running","userId":"did:web:example.org:users:alice","created":"2026-10-01T00:00:00.000Z"}""")

private val PROGRESSED: JsonObject =
    Json.parseToJsonElement("""{"resourceId":"res-1","jobId":"job-1","jobType":"mark","percentage":10,"progress":{"percentage":10}}""").jsonObject

private suspend fun jobFollower(given: JsonObject, bench: Bench): Subject {
    // A job queue with one job, `job-1`, which it creates when asked and says is running whenever it is asked.
    val queue = Respond { operation, payload ->
        when (operation) {
            "job:create" -> JsonObject(mapOf("jobId" to JsonPrimitive("job-1")))
            "job:status-requested" -> JOB_RUNNING
            else -> REFUSE_UNSCRIPTED.respond(operation, payload)
        }
    }
    val transport = bench.held(FaultyTransport(emptyList(), queue, null, bench.context))
    val gateway = Recording()
    val client = bench.held(SemiontClient(transport, gateway, gateway, ClientTiming(), null, bench.context, bench.clock))
    bench.work.launch { client.mark.delegate(RESOURCE, HighlightingJobParams()).collect {} }
    return Subject({ transport.requestLog.count { it.channel == "job:status-requested" } }, { transport.deliver(Frame("job:report-progress", PROGRESSED)) })
}

/** A client's poll of `job-1`, naming no interval and no limit, over a job queue that says the job is running whenever it is asked. */
private fun jobPolled(bench: Bench): Pair<FaultyTransport, Deferred<JobStatusResponse>> {
    val queue = Respond { operation, payload -> if (operation == "job:status-requested") JOB_RUNNING else REFUSE_UNSCRIPTED.respond(operation, payload) }
    val transport = bench.held(FaultyTransport(emptyList(), queue, null, bench.context))
    val gateway = Recording()
    val client = bench.held(SemiontClient(transport, gateway, gateway, ClientTiming(), null, bench.context, bench.clock))
    return transport to bench.work.async { client.job.pollUntilComplete(JobId("job-1")) }
}

private suspend fun jobPoll(given: JsonObject, bench: Bench): Subject {
    val (transport, _) = jobPolled(bench)
    return Subject({ transport.requestLog.count { it.channel == "job:status-requested" } }, null)
}

private suspend fun jobPollTimeout(given: JsonObject, bench: Bench): Subject {
    val (_, polling) = jobPolled(bench)
    return Subject(
        {
            if (!polling.isCompleted) {
                0
            } else {
                val failure = polling.getCompletionExceptionOrNull()
                assertTrue(failure is BusRequestError && failure.reason == BusRequestErrorCode.Timeout, "the poll ended otherwise: $failure")
                1
            }
        },
        null,
    )
}

/** How this SDK builds each subject the table names. */
private val SUBJECTS: Map<String, suspend (JsonObject, Bench) -> Subject> = mapOf(
    "refusedStream" to ::refusedStream,
    "unansweredStream" to ::unansweredStream,
    "degradedStream" to ::degradedStream,
    "scopeTaken" to ::scopeTaken,
    "scopeLetGo" to ::scopeLetGo,
    "handoffLinger" to ::handoffLinger,
    "renewal" to ::renewal,
    "deviceGrant" to ::deviceGrant,
    "heldJobStall" to ::heldJobStall,
    "discovery" to ::discovery,
    "invalidationWindow" to ::invalidationWindow,
    "saveDebounce" to ::saveDebounce,
    "jobFollower" to ::jobFollower,
    "unansweredRequest" to ::unansweredRequest,
    "unansweredEmit" to ::unansweredEmit,
    "refusedBusRequest" to ::refusedBusRequest,
    "timedOutBusRequest" to ::timedOutBusRequest,
    "jobPoll" to ::jobPoll,
    "jobPollTimeout" to ::jobPollTimeout,
)

// ── A case, played ──────────────────────────────────────────────────────

private fun perform(bench: Bench, subject: Subject, step: JsonElement) {
    val test = bench.test
    when {
        step is JsonPrimitive && step.content == "settle" -> test.runCurrent()
        step is JsonPrimitive && step.content == "act" -> {
            val act = subject.act ?: throw AssertionError("the subject has no action")
            val acting = bench.work.async { act() }
            test.runCurrent()
            if (!acting.isCompleted) throw AssertionError("the action did not end without the clock moving")
            acting.getCompleted()
        }
        step is JsonObject && "pass" in step -> {
            test.runCurrent()
            test.advanceTimeBy(durationMs(step.getValue("pass")))
            test.runCurrent()
        }
        step is JsonObject && "counted" in step -> {
            test.runCurrent()
            val expected = step.getValue("counted").jsonPrimitive.int
            val counted = subject.counted()
            if (counted != expected) throw AssertionError("counted $counted, not $expected")
        }
        else -> throw AssertionError("no step this runner performs")
    }
}

private fun play(case: JsonObject) = runTest {
    val bench = Bench(this)
    try {
        val subject = SUBJECTS.getValue(case.getValue("subject").text())(case["given"]?.jsonObject ?: JsonObject(emptyMap()), bench)
        for ((at, step) in case.getValue("steps").jsonArray.withIndex()) {
            try {
                perform(bench, subject, step)
            } catch (broken: AssertionError) {
                throw AssertionError("steps[$at] $step, at ${testScheduler.currentTime} ms: ${broken.message}", broken)
            }
        }
    } finally {
        bench.close()
    }
}

/**
 * Every wait a client keeps ends when protocol/specs/src/client/clock-cases.json
 * says, on a clock the test moves: each subject is made with a dispatcher on
 * the test's scheduler, its clock, and a random source that draws its lowest.
 */
class ClockCasesTest {
    @Test
    fun thisRunnerBuildsEverySubjectTheTableNamesAndNoOther() {
        assertEquals(CASES.map { it.getValue("subject").text() }.toSet(), SUBJECTS.keys)
    }

    @TestFactory
    fun aWaitEndsWhenItsCaseSays(): List<DynamicTest> =
        CASES.map { case -> DynamicTest.dynamicTest("${case.getValue("subject").text()}: ${case.getValue("case").text()}") { play(case) } }

    @Test
    fun theRunnerFailsACaseWhoseWaitEndsAMillisecondEarly() {
        val case = CASES.first { it.getValue("subject").text() == "refusedStream" }
        val steps = case.getValue("steps").jsonArray
        // The last millisecond of the first wait: the case is told the stream was opened again in it.
        assertEquals(JsonObject(mapOf("counted" to JsonPrimitive(1))), steps[2])
        val told = JsonObject(case + ("steps" to JsonArray(steps.toMutableList().also { it[2] = JsonObject(mapOf("counted" to JsonPrimitive(2))) })))
        val broken = assertThrows<AssertionError> { play(told) }
        assertEquals(true, broken.message?.startsWith("steps[2] "), broken.message)
    }
}
