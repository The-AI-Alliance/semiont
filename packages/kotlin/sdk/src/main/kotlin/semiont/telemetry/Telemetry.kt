package semiont.telemetry

import io.opentelemetry.api.GlobalOpenTelemetry
import io.opentelemetry.api.OpenTelemetry
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.api.common.Attributes
import io.opentelemetry.api.trace.SpanKind
import io.opentelemetry.api.trace.StatusCode
import io.opentelemetry.context.Context
import io.opentelemetry.context.propagation.TextMapGetter
import io.opentelemetry.extension.kotlin.asContextElement
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.future.future
import kotlinx.coroutines.withContext
import semiont.identifiers.ResourceId
import semiont.transport.TraceContext
import java.util.concurrent.CompletableFuture
import kotlin.coroutines.CoroutineContext

/** A span of the telemetry table: its name, which may hold `{channel}`, and its kind. */
internal class SpanRow(val name: String, val kind: SpanKind)

/** A counter of the telemetry table: its name, and what it counts. */
internal class MetricRow(val name: String, val meaning: String)

private const val SCOPE = "semiont"
private const val CHANNEL = "{channel}"

private val BUS_CHANNEL = AttributeKey.stringKey("bus.channel")
private val BUS_SCOPE = AttributeKey.stringKey("bus.scope")
private val CONTENT_FORMAT = AttributeKey.stringKey("content.format")
private val CONTENT_SIZE_BYTES = AttributeKey.longKey("content.size_bytes")
private val CONTENT_STREAM = AttributeKey.booleanKey("content.stream")
private val RESOURCE_ID = AttributeKey.stringKey("resource.id")

/**
 * What this SDK's transports tell OpenTelemetry (specs/src/sdk-telemetry/telemetry.json).
 *
 * It takes OpenTelemetry's API and nothing more, so every OpenTelemetry choice
 * is the application's: every call here does nothing until the process
 * installs its OpenTelemetry as the global one, and a trace travels by the
 * propagators that one names. The global one is asked for each time it is
 * used, and never installed here, so a process that installs its own after
 * this SDK has begun is still told.
 *
 * A request carries the trace it was made in: work launched on a caller's
 * behalf runs in the caller's trace, and a span current while a request is
 * sent puts its trace in the request's headers. A frame brings the trace it
 * was sent under, and the span that marks its arrival continues that trace.
 */
internal object Telemetry {
    /** The process's OpenTelemetry, asked for without installing one: a process that has none yet may install its own later. */
    private fun otel(): OpenTelemetry = GlobalOpenTelemetry.getOrNoop()

    /** Run `work` in a span of `row`, current while it runs, so what it sends carries the span's trace. */
    suspend fun <T> within(row: SpanRow, attributes: Attributes, channel: String = "", work: suspend () -> T): T {
        val span = otel().getTracer(SCOPE).spanBuilder(row.name.replace(CHANNEL, channel))
            .setSpanKind(row.kind)
            .setAllAttributes(attributes)
            .startSpan()
        try {
            return withContext(Context.current().with(span).asContextElement()) { work() }
        } catch (error: Throwable) {
            span.setStatus(StatusCode.ERROR)
            throw error
        } finally {
            span.end()
        }
    }

    /** The headers that carry the trace the current work is in: none when it is in none. */
    fun headers(): Map<String, String> = carried(Context.current())

    private fun carried(context: Context): Map<String, String> {
        val carrier = mutableMapOf<String, String>()
        otel().propagators.textMapPropagator.inject(context, carrier) { into, key, value -> into?.put(key, value) }
        return carrier
    }

    private fun onTheBus(channel: String, scope: ResourceId?): Attributes =
        if (scope == null) Attributes.of(BUS_CHANNEL, channel) else Attributes.of(BUS_CHANNEL, channel, BUS_SCOPE, scope.value)

    /** One emit: counted as sent, and run in its span. */
    suspend fun <T> emitting(channel: String, scope: ResourceId?, work: suspend () -> T): T {
        val attributes = onTheBus(channel, scope)
        val sent = TelemetryTable.SEMIONT_BUS_SENT
        otel().getMeter(SCOPE).counterBuilder(sent.name).setDescription(sent.meaning).build().add(1, attributes)
        return within(TelemetryTable.BUS_EMIT, attributes, channel, work)
    }

    /**
     * Mark a frame's arrival, in the trace it was sent under; one sent under
     * none begins a trace of its own. Returns the trace the work done for the
     * frame continues: the arrival's own span when one was recorded, and what
     * the frame brought otherwise.
     */
    fun received(channel: String, scope: ResourceId?, sentUnder: TraceContext?): TraceContext? {
        val parent = sentUnder?.let { sent ->
            val carrier = buildMap {
                put("traceparent", sent.traceparent)
                sent.tracestate?.let { put("tracestate", it) }
            }
            otel().propagators.textMapPropagator.extract(Context.root(), carrier, MapGetter)
        } ?: Context.root()
        val row = TelemetryTable.BUS_RECV
        val span = otel().getTracer(SCOPE).spanBuilder(row.name.replace(CHANNEL, channel))
            .setParent(parent)
            .setSpanKind(row.kind)
            .setAllAttributes(onTheBus(channel, scope))
            .startSpan()
        span.end()
        val arrived = carried(parent.with(span))
        val traceparent = arrived["traceparent"] ?: return sentUnder
        return TraceContext(traceparent, arrived["tracestate"]?.takeIf { it.isNotEmpty() })
    }

    /** An upload, run in its span. */
    suspend fun <T> putting(mediaType: String, sizeBytes: Long, work: suspend () -> T): T =
        within(TelemetryTable.CONTENT_PUT, Attributes.of(CONTENT_FORMAT, mediaType, CONTENT_SIZE_BYTES, sizeBytes), work = work)

    /** A read of a resource's bytes, run in its span. */
    suspend fun <T> getting(resourceId: ResourceId, stream: Boolean, work: suspend () -> T): T {
        val attributes = if (stream) Attributes.of(RESOURCE_ID, resourceId.value, CONTENT_STREAM, true) else Attributes.of(RESOURCE_ID, resourceId.value)
        return within(TelemetryTable.CONTENT_GET, attributes, work = work)
    }

    /** A read of a resource's description, run in its span. */
    suspend fun <T> gettingGraph(resourceId: ResourceId, work: suspend () -> T): T =
        within(TelemetryTable.CONTENT_GET_GRAPH, Attributes.of(RESOURCE_ID, resourceId.value), work = work)

    /** A read of a resource's annotations, run in its span. */
    suspend fun <T> gettingAnnotations(resourceId: ResourceId, work: suspend () -> T): T =
        within(TelemetryTable.CONTENT_GET_ANNOTATIONS, Attributes.of(RESOURCE_ID, resourceId.value), work = work)

    /** A read of a resource's anchored text, run in its span. */
    suspend fun <T> gettingAnchoredText(resourceId: ResourceId, work: suspend () -> T): T =
        within(TelemetryTable.CONTENT_GET_ANCHORED_TEXT, Attributes.of(RESOURCE_ID, resourceId.value), work = work)
}

private object MapGetter : TextMapGetter<Map<String, String>> {
    override fun get(carrier: Map<String, String>?, key: String): String? = carrier?.get(key)
}

/** The trace the caller is in, as a coroutine's context: work launched on the caller's behalf runs in it. */
internal fun callersTrace(): CoroutineContext = Context.current().asContextElement()

/** `work` as a future, for Java, run in the trace its caller is in. */
internal fun <T> CoroutineScope.futureOf(work: suspend () -> T): CompletableFuture<T> = future(callersTrace()) { work() }
