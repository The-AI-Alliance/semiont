package semiont.retry

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.Spec
import semiont.errors.TransportError

/** Trying again, held to the cases every SDK runs (specs/src/retry/cases.json). */
class RetryCasesTest {
    private val table = Spec.read("retry/cases.json").jsonObject

    /** The rules of the table this SDK keeps none of, and why. */
    private val notThisSdks = mapOf("job" to "a job's retry budget is its worker's, which is not this SDK's")

    @TestFactory
    fun eachRuleRetriesWhatTheTableSays(): List<DynamicTest> = table.getValue("rules").jsonArray.map { it.jsonObject }.map { row ->
        DynamicTest.dynamicTest(row.getValue("why").jsonPrimitive.content) {
            val named = row.getValue("rule").jsonPrimitive.content
            if (named in notThisSdks) return@dynamicTest
            val rule = RETRY_RULES[named] ?: error("the table names the rule $named, which this SDK neither keeps nor says why not")
            val facts = RetryFacts(status = row["status"]?.jsonPrimitive?.int, method = row["method"]?.jsonPrimitive?.content)
            assertEquals(row.getValue("retries").jsonPrimitive.content.toBooleanStrict(), rule.retryable(facts))
        }
    }

    @Test
    fun theRulesAreTheTablesAndNoneBeside() {
        val named = table.getValue("rules").jsonArray.map { it.jsonObject.getValue("rule").jsonPrimitive.content }.toSet()
        assertEquals(named - notThisSdks.keys, RETRY_RULES.keys)
    }

    @TestFactory
    fun aRetryAfterHeaderStatesTheWaitTheTableGives(): List<DynamicTest> = table.getValue("retryAfter").jsonArray.map { it.jsonObject }.map { row: JsonObject ->
        DynamicTest.dynamicTest(row.getValue("why").jsonPrimitive.content) {
            val header = row["header"]?.takeUnless { it is kotlinx.serialization.json.JsonNull }?.jsonPrimitive?.content
            val ms = row["ms"]?.takeUnless { it is kotlinx.serialization.json.JsonNull }?.jsonPrimitive?.long
            assertEquals(ms, retryAfterMs(header))
        }
    }

    private fun refused(status: Int, retryAfterMs: Long? = null) = TransportError.ofStatus("refused $status", status, retryAfterMs)

    private val quick = RetryPolicy(attempts = 3, initialDelayMs = 1, maxDelayMs = 2)

    @Test
    fun aFailureWorthAnotherAttemptIsTriedAgainUntilTheAttemptsAreSpent() = runBlocking {
        var made = 0
        val error = assertThrows(TransportError::class.java) {
            runBlocking { retryWithBackoff(quick, { BOOT.retryable(RetryFacts(status = it.status())) }) { made += 1; throw refused(503) } }
        }
        assertEquals(503, error.status)
        assertEquals(3, made)
    }

    @Test
    fun aFailureNotWorthAnotherAttemptIsThrownAtOnce() = runBlocking {
        var made = 0
        assertThrows(TransportError::class.java) {
            runBlocking { retryWithBackoff(quick, { BOOT.retryable(RetryFacts(status = it.status())) }) { made += 1; throw refused(400) } }
        }
        assertEquals(1, made)
    }

    @Test
    fun anAttemptThatSucceedsIsTheAnswer() = runBlocking {
        var made = 0
        val answer = retryWithBackoff(quick, { BOOT.retryable(RetryFacts(status = it.status())) }) {
            made += 1
            if (made < 3) throw refused(429)
            "third time"
        }
        assertEquals("third time", answer)
    }

    @Test
    fun theWaitIsNeverLessThanTheFailureStated() = runBlocking {
        val started = System.nanoTime()
        var made = 0
        retryWithBackoff(RetryPolicy(attempts = 2, initialDelayMs = 1, maxDelayMs = 1), { true }) {
            made += 1
            if (made == 1) throw refused(429, retryAfterMs = 200)
        }
        assertTrue((System.nanoTime() - started) / 1_000_000 >= 200)
    }

    @Test
    fun cancellingGivesUpAWaitInProgress() = runBlocking {
        var made = 0
        val retrying = launch {
            retryWithBackoff(RetryPolicy(attempts = 5, initialDelayMs = 60_000, maxDelayMs = 60_000), { true }) {
                made += 1
                throw refused(429)
            }
        }
        delay(100)
        withTimeout(5_000) {
            retrying.cancel(CancellationException("given up"))
            retrying.join()
        }
        assertEquals(1, made)
    }

    private fun semiont.errors.SemiontError.status(): Int? = (this as? TransportError)?.status
}
