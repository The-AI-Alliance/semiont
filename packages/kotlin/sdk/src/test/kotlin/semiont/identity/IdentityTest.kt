package semiont.identity

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.Spec

/**
 * How a knowledge base and its principals are named, held to the tables every
 * implementation runs: specs/src/principals/cases.json for a person and a
 * software agent, and specs/src/kb-identity/cases.json for the knowledge base,
 * each case of which that has a domain this SDK derives the DID and the
 * resource from. Reading the project file is its readers', not this SDK's.
 */
class IdentityTest {
    private val principals = Spec.read("principals/cases.json").jsonObject
    private val knowledgeBases = Spec.read("kb-identity/cases.json").jsonObject.getValue("cases").jsonArray.map { it.jsonObject }
        .filter { it.getValue("domain") !is JsonNull }

    private fun JsonObject.text(name: String): String = getValue(name).jsonPrimitive.content

    @TestFactory
    fun aPersonIsNamedAsTheTableNamesOne(): List<DynamicTest> = principals.getValue("people").jsonArray.map { it.jsonObject }.map { case ->
        DynamicTest.dynamicTest(case.text("why")) {
            assertEquals(case.text("did"), personDid(case.text("domain"), case.text("subject")).value)
        }
    }

    @TestFactory
    fun aSoftwareAgentIsNamedAsTheTableNamesOne(): List<DynamicTest> = principals.getValue("agents").jsonArray.map { it.jsonObject }.map { case ->
        DynamicTest.dynamicTest(case.text("why")) {
            val (domain, provider, model) = Triple(case.text("domain"), case.text("provider"), case.text("model"))
            assertEquals(case.text("did"), agentDid(domain, provider, model).value)
            assertEquals(case.text("email"), agentAddress(domain, provider, model))
            assertEquals(case.text("name"), agentName(provider, model))
        }
    }

    @TestFactory
    fun aKnowledgeBaseIsNamedByItsDomain(): List<DynamicTest> = knowledgeBases.map { case ->
        DynamicTest.dynamicTest(case.text("why")) {
            assertEquals(case.text("did"), kbDid(case.text("domain")).value)
            assertEquals(case.text("resource"), kbResource(case.text("domain")))
        }
    }

    @Test
    fun theTablesWereRead() {
        assertTrue(principals.getValue("people").jsonArray.isNotEmpty() && principals.getValue("agents").jsonArray.isNotEmpty())
        assertTrue(knowledgeBases.isNotEmpty())
    }
}
