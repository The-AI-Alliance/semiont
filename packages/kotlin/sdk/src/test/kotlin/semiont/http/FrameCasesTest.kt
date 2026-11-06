package semiont.http

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.flow.transformWhile
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.Spec
import semiont.bus.Bus
import semiont.bus.Fault
import semiont.bus.UNDECODED
import semiont.channels.Channels
import semiont.errors.SemiontError
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.frame
import semiont.sameJson
import semiont.transport.Carried
import semiont.transport.Delivered
import semiont.transport.Frame
import semiont.transport.FrameRefusal
import semiont.transport.FrameRefusalReason
import semiont.transport.Heard
import semiont.types.BeckonFocusEvent

/** The channel every case told to its readers is on but a request's, read here by type. */
private val READ = Channels.BECKON_FOCUS

/** The replies a request's case awaits, of `browse:resource-requested`: the first is the channel its readers are told on. */
private val REPLIES = listOf(Channels.BROWSE_RESOURCE_RESULT.name, Channels.BROWSE_RESOURCE_FAILED.name)

/** The correlation id a request's case names the request awaiting its reply by. */
private const val AWAITED = "c-1"

/** A line that names no channel: what the failure report is told after each case's line. */
private const val NAMES_NO_CHANNEL = "{"

/** The frame each case's line is followed by, read cleanly. */
private val AFTER = """{"channel": "${READ.name}", "payload": {"resourceId": "after"}}"""

private fun isAfter(heard: Heard<BeckonFocusEvent>): Boolean = heard is Delivered && heard.payload.resourceId.value == "after"

private fun isTheFrameAfter(carried: Carried): Boolean = carried is Frame && carried.payload["resourceId"] == JsonPrimitive("after")

/** What the failure report is told of a line with `fault`. */
private fun told(fault: Fault) = Triple(TransportErrorCode.Error, null, "the stream carried what is not a frame: $fault")

/** What `failure` says, as `told` states it. */
private fun said(failure: SemiontError) = assertInstanceOf(TransportError::class.java, failure).let { Triple(it.reason, it.status, it.message) }

/** What came, up to the first that `last` holds of, and without it. */
private suspend fun <T> Flow<T>.before(last: (T) -> Boolean): List<T> =
    withTimeout(5_000) {
        transformWhile {
            emit(it)
            !last(it)
        }.toList()
    }.dropLast(1)

/** `frame` as the wire states one. */
private fun written(frame: Frame): JsonObject = JsonObject(
    buildMap {
        put("channel", JsonPrimitive(frame.channel))
        put("payload", frame.payload)
        frame.correlationId?.let { put("correlationId", JsonPrimitive(it)) }
        frame.scope?.let { put("scope", JsonPrimitive(it.value)) }
    },
)

/** A transport over a stand-in gateway, its stream open, for `read`. */
private fun carrying(read: suspend (StreamGateway, HttpTransport) -> Unit) = runBlocking {
    StreamGateway().use { gateway ->
        HttpTransport(gateway.origin, MutableStateFlow("t"), listOf(READ.name) + REPLIES).use { transport ->
            withTimeout(5_000) { while (gateway.subscriptions.isEmpty()) delay(5) }
            read(gateway, transport)
        }
    }
}

/**
 * The stream's reader, held to protocol/specs/src/bus/frame-cases.json: the
 * table every SDK's stream reader runs. Each case's line is carried on a
 * stand-in gateway's stream, followed by a line that names no channel and a
 * frame of `beckon:focus` read cleanly. What the transport delivers, what a
 * typed read of the case's channel is given, what the failure report is
 * told before that line, and what becomes of a request awaiting the case's
 * reply are each held to the case; the frame's coming shows the stream went
 * on.
 */
class FrameCasesTest {
    private val cases: List<JsonObject> = Spec.read("bus/frame-cases.json").jsonObject.getValue("cases").jsonArray.map { it.jsonObject }

    private val refused: List<JsonObject> = cases.filter { case -> case["refused"]?.jsonPrimitive?.boolean == true }

    private val delivered: List<JsonObject> = cases.filterNot { case -> case in refused }

    private fun JsonObject.why() = getValue("why").jsonPrimitive.content

    @Test
    fun theTableHasAFrameOfEachKind() {
        assertTrue(delivered.isNotEmpty())
        assertTrue(refused.any { it.getValue("reason").jsonPrimitive.content == "lacks" })
        assertTrue(refused.any { it.getValue("reason").jsonPrimitive.content == "malformed" })
        assertEquals(setOf("readers", "failure-report"), refused.map { it.getValue("told").jsonPrimitive.content }.toSet())
        assertEquals(setOf("fails", "waits"), refused.mapNotNull { it["request"]?.jsonPrimitive?.content }.toSet())
    }

    @TestFactory
    fun aFrameBusFrameAllowsIsDeliveredAsItStatesIt(): List<DynamicTest> = delivered.map { case ->
        DynamicTest.dynamicTest(case.why()) {
            assertEquals(setOf("why", "frame"), case.keys)
            val stated = case.getValue("frame").jsonObject
            carrying { gateway, transport ->
                val frames = transport.frames(stated.getValue("channel").jsonPrimitive.content)
                val failures = transport.failures()
                gateway.send("e-1", stated.toString())
                gateway.send("e-2", NAMES_NO_CHANNEL)
                val frame = withTimeout(5_000) { frames.firstOf(1) }.single().frame()
                assertTrue(sameJson(stated, written(frame)), "it is delivered as $frame")
                assertEquals(listOf(told(UNDECODED)), withTimeout(5_000) { failures.firstOf(1) }.map(::said))
            }
        }
    }

    @TestFactory
    fun aFrameBusFrameDoesNotAllowIsRefusedForTheFaultTheTableStatesAndToldToWhomItStates(): List<DynamicTest> = refused.map { case ->
        DynamicTest.dynamicTest(case.why()) {
            val line = case["data"]?.jsonPrimitive?.content
            val frame = case["frame"]?.jsonObject
            assertEquals(setOf("why", if (line == null) "frame" else "data", "refused", "member", "reason", "told"), case.keys - setOf("correlationId", "request"))
            val reason = FrameRefusalReason.entries.single { it.wire == case.getValue("reason").jsonPrimitive.content }
            val fault = Fault(case.getValue("member").jsonPrimitive.content, reason)
            val replied = frame?.get("channel") == JsonPrimitive(REPLIES.first())
            val channel = if (replied) REPLIES.first() else READ.name
            carrying { gateway, transport ->
                val awaiting = case["request"]?.let { transport.trackReply(AWAITED, REPLIES) }
                val frames = transport.frames(channel)
                val typed = Bus(transport).frames(READ)
                val typedReply = Bus(transport).frames(Channels.BROWSE_RESOURCE_RESULT)
                val failures = transport.failures()
                gateway.send("e-1", line ?: checkNotNull(frame).toString())
                gateway.send("e-2", NAMES_NO_CHANNEL)
                gateway.send("e-3", AFTER)
                val read = typed.before(::isAfter)
                // A reply's channel carries nothing but the case's line, and the frame after it is on another.
                val carried = if (replied) listOf(withTimeout(5_000) { frames.first() }) else frames.before(::isTheFrameAfter)
                val heard = if (replied) listOf(withTimeout(5_000) { typedReply.first() }) else read
                when (val whom = case.getValue("told").jsonPrimitive.content) {
                    "readers" -> {
                        assertEquals(channel, checkNotNull(frame).getValue("channel").jsonPrimitive.content)
                        val refusal = assertInstanceOf(FrameRefusal::class.java, heard.single())
                        assertEquals(Triple(channel, fault.member, fault.reason), Triple(refusal.channel, refusal.member, refusal.reason))
                        assertEquals(frame["payload"], refusal.payload)
                        assertEquals(frame["scope"]?.jsonPrimitive?.contentOrNull, refusal.scope?.value)
                        assertEquals(case["correlationId"]?.jsonPrimitive?.content, refusal.correlationId)
                        // A payload that is not its channel's is its typed reader's to refuse: the transport delivers its frame.
                        if (fault.member.startsWith("payload.")) {
                            assertEquals(frame["payload"], carried.single().frame().payload)
                        } else {
                            assertEquals(refusal, carried.single())
                        }
                        assertEquals(listOf(told(UNDECODED)), withTimeout(5_000) { failures.firstOf(1) }.map(::said))
                    }
                    "failure-report" -> {
                        assertEquals(emptyList<Carried>(), carried)
                        assertEquals(emptyList<Heard<BeckonFocusEvent>>(), heard)
                        assertEquals(listOf(told(fault), told(UNDECODED)), withTimeout(5_000) { failures.firstOf(2) }.map(::said))
                    }
                    else -> error("told to whom the table does not give: $whom")
                }
                if (awaiting != null) {
                    when (val request = case.getValue("request").jsonPrimitive.content) {
                        "fails" -> assertEquals(carried.single(), withTimeout(5_000) { awaiting.frame() })
                        "waits" -> assertNull(withTimeoutOrNull(100) { listOf(awaiting.frame()) }, "the request goes on awaiting its reply")
                        else -> error("a request the table does not give: $request")
                    }
                    awaiting.close()
                }
            }
        }
    }
}
