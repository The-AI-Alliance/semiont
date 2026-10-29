package semiont.retry

import kotlin.random.Random

/** What a retry rule is asked about a failed request: the status its answer had, when it had one, and its method. */
internal class RetryFacts(val status: Int?, val method: String?)

/** Which failures one context tries again (specs/src/retry/cases.json). A 401 is in none: a refused credential is renewed, never retried. */
internal object RetryRules {
    /** A boot pass or a bus request, where the peer is usually seconds from ready: "up, but not now". */
    fun boot(facts: RetryFacts): Boolean = facts.status in setOf(429, 503, 504)

    // Repeating these cannot cause a second effect upstream (RFC 9110 §9.2.2).
    private val idempotent = setOf("GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE")

    /** An HTTP client's request: a retryable status, on a method that cannot cause a second effect. */
    fun transport(facts: RetryFacts): Boolean =
        facts.status != null && facts.method?.uppercase() in idempotent && facts.status in setOf(408, 413, 429, 500, 502, 503, 504)

    /** Exchanging a refresh token at its issuer: its absence, or "not now", is transient; its answer is the verdict. */
    fun refresh(facts: RetryFacts): Boolean = facts.status == null || facts.status == 408 || facts.status == 429 || facts.status >= 500
}

private val wholeSeconds = Regex("[0-9]+")

/** The wait a `Retry-After` header states, when it gives whole seconds, the form the gateway sends. */
internal fun retryAfterMs(header: String?): Long? {
    val stated = header?.trim() ?: return null
    return if (wholeSeconds.matches(stated)) stated.toLong() * 1000 else null
}

/** Half of `capMs`, and a random share of the other half: callers backing off on one schedule do not come back at one instant. */
internal fun equalJitter(capMs: Long): Long = capMs / 2 + (Random.nextDouble() * (capMs / 2)).toLong()
