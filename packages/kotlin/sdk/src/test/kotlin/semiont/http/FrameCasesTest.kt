package semiont.http

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.Spec
import semiont.bus.Fault
import semiont.bus.FrameRefusalReason
import semiont.sameJson
import semiont.types.BusFrame
import semiont.types.wireJson

/** The stream's reader, held to protocol/specs/src/bus/frame-cases.json: the table every SDK's stream reader runs. */
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
    }

    @TestFactory
    fun aFrameBusFrameAllowsIsReadAsItStatesIt(): List<DynamicTest> = delivered.map { case ->
        DynamicTest.dynamicTest(case.why()) {
            assertEquals(setOf("why", "frame"), case.keys)
            val read = carried(case.getValue("frame").toString())
            assertTrue(read is Carried.Read, "it is $read")
            val written = wireJson.encodeToJsonElement(BusFrame.serializer(), (read as Carried.Read).frame)
            assertTrue(sameJson(case.getValue("frame"), written), "it is read as $written")
        }
    }

    @TestFactory
    fun aFrameBusFrameDoesNotAllowIsRefusedForTheFaultTheTableStatesAndToldToWhomItStates(): List<DynamicTest> = refused.map { case ->
        DynamicTest.dynamicTest(case.why()) {
            val line = case["data"]?.jsonPrimitive?.content
            val frame = case["frame"]?.jsonObject
            assertEquals(setOf("why", if (line == null) "frame" else "data", "refused", "member", "reason", "told"), case.keys)
            val reason = FrameRefusalReason.entries.single { it.wire == case.getValue("reason").jsonPrimitive.content }
            val channel = when (val told = case.getValue("told").jsonPrimitive.content) {
                "readers" -> checkNotNull(frame).getValue("channel").jsonPrimitive.content
                "failure-report" -> null
                else -> error("told to whom the table does not give: $told")
            }
            assertEquals(
                Carried.Refused(Fault(case.getValue("member").jsonPrimitive.content, reason), channel),
                carried(line ?: checkNotNull(frame).toString()),
            )
        }
    }
}
