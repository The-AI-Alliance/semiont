package semiont.resources

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.Spec
import semiont.bus.Fault
import semiont.bus.FrameRefusalReason
import semiont.bus.Operations
import semiont.bus.decoded
import semiont.bus.faultOf
import semiont.errors.TransportError
import semiont.sameJson
import semiont.types.Representation
import semiont.types.ResourceDescriptor
import semiont.types.ResourceDescriptorRepresentations
import semiont.types.wireJson

/** The readers of a resource, held to protocol/specs/src/resources/reader-cases.json: the table every SDK's readers run. */
class ResourceReadersTest {
    private val cases: List<JsonObject> = Spec.read("resources/reader-cases.json").jsonObject.getValue("cases").jsonArray.map { it.jsonObject }

    private val refused: List<JsonObject> = cases.filter { case -> case["refused"]?.jsonPrimitive?.boolean == true }
    private val read: List<JsonObject> = cases.filterNot { case -> case in refused }

    private fun JsonObject.why() = getValue("why").jsonPrimitive.content

    private fun resource(case: JsonObject): ResourceDescriptor = wireJson.decodeFromJsonElement(ResourceDescriptor.serializer(), case.getValue("resource"))

    @Test
    fun theTableHasAResourceOfEachShape() {
        // What the cases must tell apart: one representation from a list of them, the first of a list from the
        // others, a resource with none, and a resource that states entity types from one that states none.
        val stated = read.map { resource(it).representations }
        assertTrue(stated.any { it is Representation })
        assertTrue(stated.any { it is ResourceDescriptorRepresentations.List && it.value.size > 1 })
        assertTrue(stated.any { it is ResourceDescriptorRepresentations.List && it.value.isEmpty() })
        assertTrue(read.any { it.getValue("entityTypes").jsonArray.isNotEmpty() })
        assertTrue(read.any { it.getValue("entityTypes").jsonArray.isEmpty() })
        assertTrue(refused.any { it.getValue("reason").jsonPrimitive.content == "lacks" })
        assertTrue(refused.any { it.getValue("reason").jsonPrimitive.content == "malformed" })
    }

    @TestFactory
    fun everyReaderGivesWhatTheTableSays(): List<DynamicTest> = read.map { case ->
        DynamicTest.dynamicTest(case.why()) {
            // A member this does not read would be a rule this SDK is not held to.
            assertTrue(case.keys.all { it in setOf("why", "resource", "entityTypes", "primaryRepresentation", "primaryMediaType") }, "${case.keys}")
            val resource = resource(case)
            val found = primaryRepresentation(resource)?.let { wireJson.encodeToJsonElement(Representation.serializer(), it) }
            val stated = case["primaryRepresentation"]
            assertTrue(if (stated == null) found == null else found != null && sameJson(stated, found), "the primary representation is $found")
            assertEquals(case["primaryMediaType"]?.jsonPrimitive?.content, primaryMediaType(resource))
            assertEquals(case.getValue("entityTypes").jsonArray.map { it.jsonPrimitive.content }, resourceEntityTypes(resource))
            assertEquals(null, faultOf(ResourceDescriptor.serializer().descriptor, case.getValue("resource")))
        }
    }

    @TestFactory
    fun aResourceTheSchemaDoesNotAllowIsRefusedForTheFaultTheTableStates(): List<DynamicTest> = refused.map { case ->
        DynamicTest.dynamicTest(case.why()) {
            // Its first fault, named as every SDK names it; and the client's read of a resource, which holds the
            // reply to the table before it decodes it, refuses the resource for that fault.
            assertEquals(setOf("why", "resource", "refused", "member", "reason"), case.keys)
            val member = case.getValue("member").jsonPrimitive.content
            val reason = FrameRefusalReason.entries.single { it.wire == case.getValue("reason").jsonPrimitive.content }
            assertEquals(Fault(member, reason), faultOf(ResourceDescriptor.serializer().descriptor, case.getValue("resource")))
            val result = Operations.BROWSE_RESOURCE_REQUESTED.result
            val reply = buildJsonObject {
                put("response", buildJsonObject { put("resource", case.getValue("resource")); put("lastSequence", 1) })
            }
            val refusal = assertThrows(TransportError::class.java) { decoded(result, reply) }
            val within = listOf("response.resource", member).filter { it.isNotEmpty() }.joinToString(".")
            assertEquals("a payload on ${result.name} is not that channel's: ${Fault(within, reason)}", refusal.message)
            // A member it lacks is one its type cannot be made without, so the decoder alone refuses that too. A size
            // or a form is the table's to refuse, and the decoder does not hold it.
            if (reason == FrameRefusalReason.Lacks) assertThrows(SerializationException::class.java) { resource(case) }
        }
    }
}
