package semiont.http

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import semiont.Spec
import semiont.types.HttpEndpoint
import semiont.types.wireJson

/** A knowledge base's gateway origin, made from its HTTP endpoint (specs/src/session/gateway-url-cases.json). */
class GatewayUrlTest {
    @TestFactory
    fun theOriginIsTheTables(): List<DynamicTest> = Spec.read("session/gateway-url-cases.json").jsonObject.getValue("cases").jsonArray.map { it.jsonObject }.map { case ->
        DynamicTest.dynamicTest(case.getValue("why").jsonPrimitive.content) {
            val endpoint = wireJson.decodeFromJsonElement(HttpEndpoint.serializer(), case.getValue("endpoint"))
            val origin = case.getValue("origin")
            if (origin is JsonNull) {
                assertFalse(isValidHostname(endpoint.host))
                // A host that is no name is never put into a URL.
                assertThrows(IllegalArgumentException::class.java) { gatewayUrl(endpoint) }
            } else {
                assertEquals(origin.jsonPrimitive.content, gatewayUrl(endpoint))
            }
        }
    }
}
