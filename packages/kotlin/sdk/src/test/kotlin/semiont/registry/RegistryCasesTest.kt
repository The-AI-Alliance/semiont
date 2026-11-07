package semiont.registry

import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import semiont.Spec
import semiont.types.KbEndpointSerializer
import semiont.types.wireJson

private val table = Spec.read("session/registry-cases.json").jsonObject

/** When a registry takes two endpoints for one place, and the order it shows what is open in (protocol/specs/src/session/registry-cases.json). */
class RegistryCasesTest {
    @TestFactory
    fun onePlaceIsTheTables(): List<DynamicTest> = table.getValue("cases").jsonArray.map { it.jsonObject }.map { case ->
        DynamicTest.dynamicTest(case.getValue("why").jsonPrimitive.content) {
            val one = wireJson.decodeFromJsonElement(KbEndpointSerializer, case.getValue("one"))
            val other = wireJson.decodeFromJsonElement(KbEndpointSerializer, case.getValue("other"))
            val same = case.getValue("samePlace").jsonPrimitive.boolean
            assertEquals(same, samePlace(one, other))
            assertEquals(same, samePlace(other, one), "the other way round")
        }
    }

    @TestFactory
    fun whatIsOpenIsShownInTheTablesOrder(): List<DynamicTest> = table.getValue("openResourceOrder").jsonArray.map { it.jsonObject }.map { case ->
        DynamicTest.dynamicTest(case.getValue("why").jsonPrimitive.content) {
            val open = case.getValue("open").jsonArray.map { wireJson.decodeFromJsonElement(OpenResource.serializer(), it) }
            val shown = case.getValue("shown").jsonArray.map { it.jsonPrimitive.content }
            assertEquals(shown, sortOpenResources(open).map { it.id.value })
        }
    }
}
