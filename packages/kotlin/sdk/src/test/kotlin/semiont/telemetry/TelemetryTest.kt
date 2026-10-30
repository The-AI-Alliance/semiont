package semiont.telemetry

import io.opentelemetry.api.GlobalOpenTelemetry
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.api.trace.SpanKind
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator
import io.opentelemetry.context.propagation.ContextPropagators
import io.opentelemetry.sdk.OpenTelemetrySdk
import io.opentelemetry.sdk.common.CompletableResultCode
import io.opentelemetry.sdk.trace.SdkTracerProvider
import io.opentelemetry.sdk.trace.data.SpanData
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor
import io.opentelemetry.sdk.trace.export.SpanExporter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import semiont.identifiers.ResourceId
import semiont.transport.TraceContext
import java.util.concurrent.CopyOnWriteArrayList

/** Each span a test's work ended. */
private class Kept : SpanExporter {
    val spans = CopyOnWriteArrayList<SpanData>()

    override fun export(spans: Collection<SpanData>): CompletableResultCode {
        this.spans += spans
        return CompletableResultCode.ofSuccess()
    }

    override fun flush(): CompletableResultCode = CompletableResultCode.ofSuccess()

    override fun shutdown(): CompletableResultCode = CompletableResultCode.ofSuccess()
}

private const val SENT_UNDER = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"

class TelemetryTest {
    private val kept = Kept()

    @BeforeEach
    fun install() {
        GlobalOpenTelemetry.resetForTest()
        OpenTelemetrySdk.builder()
            .setTracerProvider(SdkTracerProvider.builder().addSpanProcessor(SimpleSpanProcessor.create(kept)).build())
            .setPropagators(ContextPropagators.create(W3CTraceContextPropagator.getInstance()))
            .buildAndRegisterGlobal()
    }

    @AfterEach
    fun uninstall() {
        GlobalOpenTelemetry.resetForTest()
    }

    @Test
    fun anEmitSendsTheTraceOfItsOwnSpanWhereverItsWorkRuns() = runBlocking {
        val scope = ResourceId.parse("res-one")!!
        // The work resumes on another thread, and its span is still the current one there.
        val sent = Telemetry.emitting("beckon:focus", scope) { withContext(Dispatchers.IO) { Telemetry.headers() } }
        val span = kept.spans.single()
        assertEquals("bus.emit:beckon:focus", span.name)
        assertEquals(SpanKind.PRODUCER, span.kind)
        assertEquals("beckon:focus", span.attributes.get(AttributeKey.stringKey("bus.channel")))
        assertEquals("res-one", span.attributes.get(AttributeKey.stringKey("bus.scope")))
        assertEquals("00-${span.traceId}-${span.spanId}", sent["traceparent"]?.substringBeforeLast('-'))
    }

    @Test
    fun aFrameIsReceivedInTheTraceItWasSentUnder() {
        val continued = Telemetry.received("beckon:focus", null, TraceContext(SENT_UNDER))
        val span = kept.spans.single()
        assertEquals("bus.recv:beckon:focus", span.name)
        assertEquals(SpanKind.CONSUMER, span.kind)
        assertEquals("0af7651916cd43dd8448eb211c80319c", span.traceId)
        assertEquals("b7ad6b7169203331", span.parentSpanId)
        assertEquals(null, span.attributes.get(AttributeKey.stringKey("bus.scope")))
        // The work done for the frame continues the arrival's own span.
        assertEquals("00-${span.traceId}-${span.spanId}", continued?.traceparent?.substringBeforeLast('-'))
    }

    @Test
    fun aFrameSentUnderNoTraceBeginsOneOfItsOwn() {
        val continued = Telemetry.received("beckon:focus", null, null)
        val span = kept.spans.single()
        assertFalse(span.parentSpanContext.isValid)
        assertEquals("00-${span.traceId}-${span.spanId}", continued?.traceparent?.substringBeforeLast('-'))
    }

    @Test
    fun withNoOpenTelemetryInstalledAFrameKeepsTheTraceItBrought() {
        GlobalOpenTelemetry.resetForTest()
        assertEquals(TraceContext(SENT_UNDER), Telemetry.received("beckon:focus", null, TraceContext(SENT_UNDER)))
        assertEquals(null, Telemetry.received("beckon:focus", null, null))
    }
}
