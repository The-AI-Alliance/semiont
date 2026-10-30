package semiont.jobs

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import semiont.Spec
import semiont.types.FailureClass

private fun cases(table: String): List<JsonObject> = Spec.read(table).jsonObject.getValue("cases").jsonArray.map { it.jsonObject }

/** The two tables a worker answers alike with the dispatcher: specs/src/jobs/filter-cases.json and retry-cases.json. */
class JobTablesTest {
    @Test
    fun whetherAJobMatchesAFilterIsTheTablesAnswer() {
        val cases = cases("jobs/filter-cases.json")
        for (case in cases) {
            val matches = case.getValue("matches").jsonPrimitive.boolean
            assertEquals(matches, jobMatchesFilter(case.getValue("filter").jsonObject, case.getValue("job").jsonObject), case.getValue("why").jsonPrimitive.content)
        }
        assertEquals(setOf(true, false), cases.map { it.getValue("matches").jsonPrimitive.boolean }.toSet(), "the table asks both ways")
    }

    @Test
    fun whetherAFailedJobIsRetriedIsTheTablesAnswer() {
        val cases = cases("jobs/retry-cases.json")
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val failureClass = case["failureClass"]?.jsonPrimitive?.content?.let { stated -> FailureClass.entries.single { it.value == stated } }
            val retries = willRetryAfter(case.getValue("retryCount").jsonPrimitive.long, case.getValue("maxRetries").jsonPrimitive.long, failureClass)
            assertEquals(case.getValue("retries").jsonPrimitive.boolean, retries, case.getValue("why").jsonPrimitive.content)
        }
    }
}
