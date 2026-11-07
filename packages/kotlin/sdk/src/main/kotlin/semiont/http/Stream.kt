@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package semiont.http

import semiont.bus.Logged
import semiont.bus.BusLog
import semiont.bus.Fault
import semiont.bus.UNDECODED
import semiont.bus.faultOf
import semiont.telemetry.Telemetry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.jdk9.asFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.onTimeout
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import semiont.Timings
import semiont.channels.RESOURCE_SCOPED_CHANNELS
import semiont.channels.TRACE_FIELD
import semiont.errors.SemiontError
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.identifiers.ResourceId
import semiont.registry.isPersistedEventId
import semiont.retry.equalJitter
import semiont.retry.retryAfterMs
import semiont.transport.Broadcast
import semiont.transport.Carried
import semiont.transport.ConnectionState
import semiont.transport.Events
import semiont.transport.Frame
import semiont.transport.FrameRefusal
import semiont.transport.FrameSink
import semiont.transport.ReplyRouter
import semiont.transport.TraceContext
import semiont.transport.scope
import semiont.types.BusFrame
import semiont.types.BusSubscribeRequest
import semiont.types.BusSubscribeRequestScopedItem
import semiont.types.wireJson
import java.io.IOException
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/** The frames, and frames' refusals, of every channel anybody listens to, a broadcast per channel, and the buses each is bridged into. */
internal class FrameHub {
    private val channels = mutableMapOf<String, Broadcast<Carried>>()
    private val bridged = mutableListOf<FrameSink>()
    private var closed = false

    @Synchronized
    fun bridge(bus: FrameSink) {
        if (!closed) bridged += bus
    }

    @Synchronized
    fun frames(channel: String): Events<Carried> {
        val broadcast = channels.getOrPut(channel) { Broadcast() }
        if (closed) broadcast.close()
        return broadcast.listen()
    }

    fun deliver(carried: Carried) {
        val (buses, broadcast) = synchronized(this) { bridged.toList() to channels[carried.channel] }
        // A client's bus keeps its scopes for what the client's own parts say to each other.
        for (bus in buses) bus.deliver(unscoped(carried))
        broadcast?.deliver(carried)
    }

    @Synchronized
    fun close() {
        closed = true
        channels.values.forEach { it.close() }
        bridged.clear()
    }
}

/** `carried`, on no scope. */
private fun unscoped(carried: Carried): Carried = if (carried.scope == null) carried else when (carried) {
    is Frame -> carried.copy(scope = null)
    is FrameRefusal -> carried.copy(scope = null)
}

/** The ids of the frames delivered last. */
internal class SeenIds(private val capacity: Int) {
    private val ids = LinkedHashSet<String>()

    /** Remember `id`. False when it was already remembered: its frame has been delivered. */
    fun remember(id: String): Boolean {
        if (!ids.add(id)) return false
        if (ids.size > capacity) ids.remove(ids.first())
        return true
    }
}

/** The longest wait before the next connect, after `failures` in a row: `reconnectMs` doubled per failure, up to the ceiling. */
internal fun backoffCapMs(reconnectMs: Long, failures: Int): Long {
    if (reconnectMs >= Timings.MAX_RECONNECT_MS) return Timings.MAX_RECONNECT_MS
    val doublings = minOf(failures, 63 - java.lang.Long.numberOfLeadingZeros(Timings.MAX_RECONNECT_MS) + 1)
    return minOf(reconnectMs shl doublings, Timings.MAX_RECONNECT_MS)
}

/**
 * The stream (protocol/contract/TRANSPORT-HTTP.md, The client). One coroutine owns
 * the subscription, the connections that carry it, and the state they add up
 * to. A drop (the stream ended, or a connect failed with none live) leaves
 * `open` and opens the stream again on a backoff, naming each scope's last
 * position and the replies still awaited. A handoff (the subscription
 * changed) opens a second connection beside the live one, which takes over
 * once it is open; the old one is read for `lingerMs` more and closed then,
 * and the state stays `open`. While both are read a frame is delivered once:
 * the ids of the last frames delivered are remembered. Connections only read;
 * what they read comes back to this coroutine, in order, so the state has one
 * writer.
 */
internal class Stream(
    private val baseUrl: String,
    private val http: HttpClient,
    private val token: StateFlow<String?>,
    private val refresher: TokenRefresher?,
    private val clientId: String,
    private val global: List<String>,
    private val timing: Timing,
    private val hub: FrameHub,
    private val router: ReplyRouter,
    private val failures: Broadcast<SemiontError>,
    private val scope: CoroutineScope,
    private val bookmarks: Bookmarks?,
) {
    private sealed interface Report

    private class Opened(val conn: Int) : Report

    private class Framed(val conn: Int, val id: String?, val data: String) : Report

    private class Refused(val conn: Int, val error: TransportError) : Report

    private class Ended(val conn: Int) : Report

    private class ScopeTaken(val resource: ResourceId) : Report

    private class ScopeLetGo(val resource: ResourceId) : Report

    private object TokenChanged : Report

    private class Renewed(val keepPrevious: Boolean) : Report

    private object Stop : Report

    private class Connection(val job: Job, val token: String, val keepPrevious: Boolean, val previous: List<Int>)

    private val stateFlow = MutableStateFlow(ConnectionState.Initial)
    val state: StateFlow<ConnectionState> get() = stateFlow
    private val reports = Channel<Report>(Channel.UNLIMITED)
    private var running = false

    private val scoped = sortedMapOf<String, Pair<ResourceId, List<String>>>()
    /** Each scope's position: where the client's last life left it, when it kept that, and what has been delivered since. */
    private val watermarks = bookmarks?.load().orEmpty().mapKeys { it.key.value }.toMutableMap()
    private val seen = SeenIds(timing.seenEventIdsCount)

    private var nextConn = 0
    private val connections = mutableMapOf<Int, Connection>()
    private var live: Int? = null
    private var connecting: Int? = null
    private var reconnectOwed = false
    private val superseded = mutableSetOf<Int>()
    private val lingering = mutableListOf<Pair<Long, List<Int>>>()

    private var failedConnects = 0
    private var refusedToken: String? = null
    private var awaitingCredential = false
    private var refresherAsked = false

    private var retryAt: Pair<Long, Boolean>? = null
    private var debounceAt: Long? = null
    private var lazyAt: Long? = null
    private var degradedAt: Long? = null

    private fun now(): Long = System.nanoTime() / 1_000_000

    fun takeScope(resource: ResourceId) {
        reports.trySend(ScopeTaken(resource))
    }

    fun letGoOfScope(resource: ResourceId) {
        reports.trySend(ScopeLetGo(resource))
    }

    /** Close: the state is `closed` from now, and the stream's coroutine ends what it started. */
    fun stop() {
        closed()
        reports.trySend(Stop)
    }

    private fun closed() {
        running = false
        stateFlow.value = ConnectionState.Closed
        hub.close()
        router.close()
    }

    /** Hold the client's stream until `stop`. */
    fun start(): Job = scope.launch {
        val watching = launch { token.collect { reports.send(TokenChanged) } }
        try {
            while (true) {
                val deadline = nextDeadline()
                val report: Report? = select {
                    reports.onReceive { it }
                    if (deadline != null) onTimeout(maxOf(0, deadline - now())) { null }
                }
                if (report == null) {
                    timers(now())
                    continue
                }
                if (report === Stop) break
                reported(report, now())
            }
        } finally {
            watching.cancel()
            connections.values.forEach { it.job.cancel() }
            connections.clear()
            closed()
        }
    }

    // ── what is reported ─────────────────────────────────────────────────

    private fun reported(report: Report, now: Long) {
        when (report) {
            is Opened -> opened(report.conn, now)
            is Framed -> framed(report.conn, report.id, report.data)
            is Refused -> refused(report.conn, report.error, now)
            is Ended -> ended(report.conn, now)
            is ScopeTaken -> {
                scoped[report.resource.value] = report.resource to RESOURCE_SCOPED_CHANNELS
                // A new scope needs to be live now: additions are gathered for the debounce, and carry any removal waiting with them.
                lazyAt = null
                debounceAt = now + Timings.RECONNECT_DEBOUNCE_MS
            }
            is ScopeLetGo -> {
                // A removal only narrows what is delivered, so it waits: a client that brushes past scopes would otherwise reopen its stream at each.
                if (scoped.remove(report.resource.value) != null && debounceAt == null && lazyAt == null) lazyAt = now + timing.lazyRemoveMs
            }
            TokenChanged -> tokenChanged(now)
            is Renewed -> scheduleRetry(0, report.keepPrevious, now)
            Stop -> Unit
        }
    }

    private fun currentToken(): String? = token.value?.takeIf { it.isNotEmpty() }

    private fun transition(to: ConnectionState, now: Long) {
        val current = stateFlow.value
        if (to == current || !current.mayBecome(to)) return
        // A stream that stays down is degraded once it has been reconnecting for the threshold.
        degradedAt = if (to == ConnectionState.Reconnecting) now + Timings.DEGRADED_THRESHOLD_MS else null
        stateFlow.value = to
    }

    private fun scheduleRetry(afterMs: Long, keepPrevious: Boolean, now: Long) {
        if (running) retryAt = (now + afterMs) to keepPrevious
    }

    /** Equal-jitter exponential backoff: a wait in [cap/2, cap]. */
    private fun backoffMs(): Long {
        val cap = backoffCapMs(timing.reconnectMs, failedConnects)
        failedConnects += 1
        return equalJitter(cap)
    }

    private fun abort(conn: Int) {
        connections.remove(conn)?.job?.cancel()
        superseded.remove(conn)
    }

    // ── connecting ───────────────────────────────────────────────────────

    private fun connect(keepPrevious: Boolean, now: Long) {
        // A transport that carries nothing opens no stream: one held only for the gateway's own operations, or to ask
        // who a token is, makes no request of the bus. Taking a resource's scope gives it something to carry.
        if (global.isEmpty() && scoped.isEmpty()) return
        // A connect with no token cannot succeed, and neither can one that sends again the token the gateway just
        // refused. Neither is attempted: the client waits, with no request, for a different one.
        val token = currentToken()
        if (token == null || token == refusedToken) {
            if (running) {
                // With a stream still live the state stays `open`: only the change of subscription waits for a credential.
                if (live == null) transition(ConnectionState.Unauthenticated, now)
                awaitingCredential = true
                scheduleRetry(timing.reconnectMs, keepPrevious, now)
            }
            return
        }
        refusedToken = null
        awaitingCredential = false

        val previous = connections.keys.toList()
        if (!keepPrevious) {
            // An initial connect, or the recovery of a drop: nothing live is worth keeping.
            previous.forEach(::abort)
            live = null
            lingering.clear()
        }
        // Opening beside a live stream is a handoff, and the state stays `open`. With none, this is `connecting`.
        if (live == null) transition(ConnectionState.Connecting, now)

        val body = BusSubscribeRequest(
            clientId = clientId,
            global = global,
            scoped = scoped.values.map { (resource, channels) -> BusSubscribeRequestScopedItem(scope = resource, channels = channels, lastEventId = watermarks[resource.value]) },
            pendingReplies = router.awaited().ifEmpty { null },
        )
        val conn = nextConn++
        val job = scope.launch { connection(conn, token, wireJson.encodeToString(BusSubscribeRequest.serializer(), body)) }
        connections[conn] = Connection(job, token, keepPrevious, if (keepPrevious) previous else emptyList())
        connecting = conn
    }

    /** A changed subscription: hand it to a new stream. The live one is not touched, and the state does not move. */
    private fun reconnect(now: Long) {
        if (!running) return
        if (connecting != null) {
            reconnectOwed = true
            return
        }
        retryAt = null
        connect(true, now)
    }

    /** The connect `conn` made is answered. Opened, it serves the changes asked for meanwhile with one follow-up. */
    private fun settleConnect(conn: Int, opened: Boolean, now: Long) {
        if (connecting != conn) return
        connecting = null
        val owed = reconnectOwed
        reconnectOwed = false
        if (opened && owed && running) reconnect(now)
    }

    private fun opened(conn: Int, now: Long) {
        val connection = connections[conn] ?: return
        if (connection.keepPrevious) {
            // The new stream is established, so the ones it replaces are retired by drain: read for `lingerMs`
            // more, then closed. Closing them now would discard what they have received and not yet delivered.
            val retired = connection.previous.filter { it in connections }
            superseded += retired
            lingering += (now + timing.lingerMs) to retired
        }
        live = conn
        transition(ConnectionState.Open, now)
        failedConnects = 0
        refresherAsked = false
        settleConnect(conn, true, now)
    }

    private fun framed(conn: Int, id: String?, data: String) {
        if (conn !in connections) return
        if (id != null && !seen.remember(id)) return
        val read = when (val line = lineOf(data)) {
            is Line.Allowed -> line.frame
            is Line.Refused -> {
                router.route(line.refusal)
                hub.deliver(line.refusal)
                return
            }
            is Line.Unaddressed -> {
                failures.deliver(TransportError(TransportErrorCode.Error, "the stream carried what is not a frame: ${line.fault}"))
                return
            }
        }
        val channel = read.channel
        var payload = read.payload
        val correlationId = read.correlationId
        val scope = read.scope
        BusLog.line(Logged.RECV, channel, payload, scope, correlationId)
        // What closing a retired connection at once would have lost.
        if (conn in superseded) BusLog.note("LINGER", channel, "delivered on superseded connection")
        var sentUnder: TraceContext? = null
        if (TRACE_FIELD in payload) {
            sentUnder = sentUnder(payload[TRACE_FIELD])
            payload = JsonObject(payload - TRACE_FIELD)
        }
        val frame = Frame(channel, payload, correlationId, scope, Telemetry.received(channel, scope, sentUnder))
        router.route(frame)
        // A scope's position is the last recorded event delivered on it: only a recorded event's id, a PersistedEventId, is one.
        if (id != null && scope != null && isPersistedEventId(id)) {
            watermarks[scope.value] = id
            bookmarks?.save(scope, id)
        }
        hub.deliver(frame)
    }

    private fun refused(conn: Int, error: TransportError, now: Long) {
        val connection = connections.remove(conn) ?: return
        settleConnect(conn, false, now)
        // A refused connect is a request the gateway refused, reported as one. A connect that got no answer is a state.
        failures.deliver(error)
        val wasSuperseded = superseded.remove(conn)
        if (error.reason == TransportErrorCode.Unauthorized && running && !wasSuperseded) {
            // Its credential was refused. This token is not sent again: the client waits for a different one, and
            // asks its refresher for one once per outage.
            refusedToken = connection.token
            failedConnects = 0
            if (live == null) transition(ConnectionState.Unauthenticated, now)
            val ask = refresher
            if (ask != null && !refresherAsked) {
                refresherAsked = true
                scope.launch {
                    try {
                        ask.refresh(connection.token)
                    } catch (_: SemiontError) {
                        // It fed the token what it could.
                    }
                    reports.send(Renewed(connection.keepPrevious))
                }
            } else {
                awaitingCredential = true
                scheduleRetry(timing.reconnectMs, connection.keepPrevious, now)
            }
            return
        }
        droppedOrFailed(conn, wasSuperseded, error.retryAfterMs ?: 0, now)
    }

    private fun ended(conn: Int, now: Long) {
        connections.remove(conn) ?: return
        settleConnect(conn, false, now)
        droppedOrFailed(conn, superseded.remove(conn), 0, now)
    }

    /** A stream ended, or a connect failed. A superseded connection ending is expected and restarts nothing. */
    private fun droppedOrFailed(conn: Int, wasSuperseded: Boolean, statedWaitMs: Long, now: Long) {
        if (!running || wasSuperseded) return
        if (live != null && live != conn) {
            // A handoff that could not open. The stream it was to replace is still live: tried again on the backoff.
            scheduleRetry(maxOf(backoffMs(), statedWaitMs), true, now)
            return
        }
        // A drop.
        live = null
        transition(ConnectionState.Reconnecting, now)
        if (connecting != null) {
            // A handoff's connect is in flight: it is the recovery now, and comes back here if it fails.
            transition(ConnectionState.Connecting, now)
            return
        }
        scheduleRetry(maxOf(backoffMs(), statedWaitMs), false, now)
    }

    private fun tokenChanged(now: Long) {
        if (!running) {
            // The stream starts when there is a token to open it with.
            if (stateFlow.value == ConnectionState.Initial && currentToken() != null) {
                running = true
                connect(false, now)
            }
            return
        }
        // A client waiting for a credential tries at once.
        val waiting = retryAt
        if (awaitingCredential && waiting != null) retryAt = now to waiting.second
    }

    // ── time ─────────────────────────────────────────────────────────────

    private fun nextDeadline(): Long? = listOfNotNull(retryAt?.first, debounceAt, lazyAt, degradedAt, lingering.minOfOrNull { it.first }).minOrNull()

    private fun timers(now: Long) {
        degradedAt?.let { at ->
            if (at <= now) {
                degradedAt = null
                if (stateFlow.value == ConnectionState.Reconnecting) stateFlow.value = ConnectionState.Degraded
            }
        }
        val over = lingering.filter { it.first <= now }
        lingering.removeAll(over)
        over.forEach { (_, conns) -> conns.forEach(::abort) }
        val debounced = debounceAt?.let { it <= now } == true
        val lazy = lazyAt?.let { it <= now } == true
        if (debounced || lazy) {
            debounceAt = null
            lazyAt = null
            reconnect(now)
        }
        retryAt?.let { (at, keepPrevious) ->
            if (at <= now) {
                retryAt = null
                if (running) connect(keepPrevious, now)
            }
        }
    }

    // ── one connection ───────────────────────────────────────────────────

    /** One connection: the subscribe request, and every event its stream carries, reported in order. */
    private suspend fun connection(conn: Int, token: String, body: String) {
        try {
            val request = HttpRequest.newBuilder(java.net.URI.create("$baseUrl/bus/subscribe"))
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .header("Authorization", "Bearer $token")
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                .timeout(Duration.ofMillis(timing.streamOpenMs))
                .build()
            val response = http.exchange(request, HttpResponse.BodyHandlers.ofPublisher())
            val status = response.statusCode()
            if (status !in 200..299) {
                // A refusal's body is read within the request deadline, as any other answer is: one not read by then says nothing.
                val read = try {
                    withTimeoutOrNull(timing.httpRequestMs) { readAll(response.body()) }
                } catch (_: IOException) {
                    null
                }
                val stated = retryAfterMs(response.headers().firstValue("retry-after").orElse(null))
                val message = when (val words = said(read)) {
                    null -> "SSE connect failed: $status"
                    else -> "SSE connect failed: $status: $words"
                }
                reports.send(Refused(conn, refusal(message, status, read, stated)))
                return
            }
            reports.send(Opened(conn))
            val parser = SseParser()
            response.body().asFlow().collect { buffers ->
                for (buffer in buffers) {
                    val bytes = ByteArray(buffer.remaining())
                    buffer.get(bytes)
                    for (event in parser.feed(bytes)) {
                        if (event.event == "bus-event" && event.data.isNotEmpty()) reports.send(Framed(conn, event.id, event.data))
                    }
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: IOException) {
            // No answer, or a stream that broke: a state, reported as the stream's end.
        }
        reports.send(Ended(conn))
    }
}

/** What a `bus-event` line carried, read as a frame. */
internal sealed interface Line {
    /** A frame BusFrame allows. */
    data class Allowed(val frame: BusFrame) : Line

    /** A frame BusFrame does not allow that names its readers, whose refusal is told to them in its place. */
    data class Refused(val refusal: FrameRefusal) : Line

    /** What names no reader, told to the failure report by its first fault. */
    data class Unaddressed(val fault: Fault) : Line
}

/**
 * `data` read as a frame, held to BusFrame by the table: a frame carries what
 * BusFrame names, and nothing more. A frame BusFrame does not allow names its
 * readers when its `channel` is a text of at least one character and it
 * carries no `scope` or one that is a resource's id, whatever its first fault.
 */
internal fun lineOf(data: String): Line {
    val element = try {
        wireJson.parseToJsonElement(data)
    } catch (_: IllegalArgumentException) {
        return Line.Unaddressed(UNDECODED)
    }
    val fault = faultOf(BusFrame.serializer().descriptor, element) ?: try {
        return Line.Allowed(wireJson.decodeFromJsonElement(BusFrame.serializer(), element))
    } catch (_: IllegalArgumentException) {
        UNDECODED
    }
    val stated = element as? JsonObject ?: return Line.Unaddressed(fault)
    val channel = (stated["channel"] as? JsonPrimitive)?.takeIf { it.isString && it.content.isNotEmpty() }?.content ?: return Line.Unaddressed(fault)
    // A null where a member may be absent is its absence, as BusFrame reads it.
    val scope = when (val held = stated["scope"]) {
        null, JsonNull -> null
        else -> (held as? JsonPrimitive)?.takeIf { it.isString }?.let { ResourceId.parse(it.content) } ?: return Line.Unaddressed(fault)
    }
    return Line.Refused(FrameRefusal(channel, fault.member, fault.reason, stated["payload"], correlationIdOf(channel, stated["correlationId"]), scope))
}

/** The correlation id a frame on `channel` carries as `held`, when BusFrame allows it, whatever the frame's other faults. */
private fun correlationIdOf(channel: String, held: JsonElement?): String? {
    // A null where a member may be absent is its absence, as BusFrame reads it.
    if (held == null || held == JsonNull) return null
    val alone = JsonObject(mapOf("channel" to JsonPrimitive(channel), "payload" to JsonObject(emptyMap()), "correlationId" to held))
    if (faultOf(BusFrame.serializer().descriptor, alone) != null) return null
    return held.jsonPrimitive.content
}

/** The trace a frame's payload says it was sent under, when it says so. */
private fun sentUnder(carried: kotlinx.serialization.json.JsonElement?): TraceContext? {
    val stated = carried as? JsonObject ?: return null
    val traceparent = (stated["traceparent"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
    val tracestate = (stated["tracestate"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
    return TraceContext(traceparent, tracestate)
}
