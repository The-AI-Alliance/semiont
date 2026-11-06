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

/** When a registry takes two endpoints for one place (protocol/specs/src/session/registry-cases.json). */
class RegistryCasesTest {
    @TestFactory
    fun onePlaceIsTheTables(): List<DynamicTest> = Spec.read("session/registry-cases.json").jsonObject.getValue("cases").jsonArray.map { it.jsonObject }.map { case ->
        DynamicTest.dynamicTest(case.getValue("why").jsonPrimitive.content) {
            val one = wireJson.decodeFromJsonElement(KbEndpointSerializer, case.getValue("one"))
            val other = wireJson.decodeFromJsonElement(KbEndpointSerializer, case.getValue("other"))
            val same = case.getValue("samePlace").jsonPrimitive.boolean
            assertEquals(same, samePlace(one, other))
            assertEquals(same, samePlace(other, one), "the other way round")
        }
    }
}
