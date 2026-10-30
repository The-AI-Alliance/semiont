package semiont.retry

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.future.await
import semiont.errors.SemiontError
import semiont.telemetry.futureOf
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.function.Predicate
import java.util.function.Supplier
import kotlin.random.Random

/** What a retry rule is asked about a failure: the status its answer had, and the request's method. What is not stated is null. */
public data class RetryFacts(public val status: Int? = null, public val method: String? = null)

/** Which failures one context tries again (specs/src/retry/cases.json). A 401 is in none: a refused credential is renewed, never retried. */
public class RetryRule internal constructor(
    /** The rule's name in the table. */
    public val name: String,
    private val rule: (RetryFacts) -> Boolean,
) {
    /** Whether a failure of these facts is worth another attempt. */
    public fun retryable(facts: RetryFacts): Boolean = rule(facts)

    override fun toString(): String = name
}

/**
 * A boot pass or a bus request, where the peer is usually seconds from ready:
 * the statuses that say "up, but not now". A 500 is not among them: replaying
 * it re-runs whatever broke it.
 */
public val BOOT: RetryRule = RetryRule("boot") { it.status in setOf(429, 503, 504) }

// Repeating these cannot cause a second effect upstream (RFC 9110 §9.2.2).
private val idempotent = setOf("GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE")

/**
 * An HTTP client's request: a retryable status, on a method that cannot cause
 * a second effect, because a POST answered 502 may already have been
 * processed.
 */
public val TRANSPORT: RetryRule = RetryRule("transport") {
    it.status != null && it.method?.uppercase() in idempotent && it.status in setOf(408, 413, 429, 500, 502, 503, 504)
}

/**
 * Exchanging a refresh token at its issuer. Its answer is the verdict and its
 * absence never is: no answer, or one saying "not now", is transient; a
 * refused grant, and any fault this rule does not name, is final.
 */
public val REFRESH: RetryRule = RetryRule("refresh") { it.status == null || it.status == 408 || it.status == 429 || it.status >= 500 }

/** Every rule this SDK keeps, by its name in the table. */
public val RETRY_RULES: Map<String, RetryRule> = listOf(BOOT, REFRESH, TRANSPORT).associateBy { it.name }

private val wholeSeconds = Regex("[0-9]+")

/** The wait a `Retry-After` header states, when it gives whole seconds, the form the gateway sends. */
public fun retryAfterMs(header: String?): Long? {
    val stated = header?.trim() ?: return null
    return if (wholeSeconds.matches(stated)) stated.toLong() * 1000 else null
}

/** Half of `capMs`, and a random share of the other half: callers backing off on one schedule do not come back at one instant, and the wait never exceeds the cap. */
public fun equalJitter(capMs: Long): Long = capMs / 2 + (Random.nextDouble() * (capMs / 2)).toLong()

/**
 * Run `attempt` until it succeeds, `policy`'s attempts are spent, or it fails
 * in a way `retryable` does not accept; the last failure is thrown as it was.
 * The wait before each further attempt is the policy's jittered backoff, and
 * never less than the wait the failure itself stated (a refusal's
 * `Retry-After`). Cancelled, it gives up: no further attempt is made, and a
 * wait in progress ends.
 */
public suspend fun <T> retryWithBackoff(policy: RetryPolicy, retryable: (SemiontError) -> Boolean, attempt: suspend () -> T): T {
    var capMs = policy.initialDelayMs
    var made = 1
    while (true) {
        try {
            return attempt()
        } catch (error: SemiontError) {
            if (made >= policy.attempts || !retryable(error)) throw error
            delay(maxOf(equalJitter(capMs), error.retryAfterMs ?: 0))
        }
        capMs = minOf(capMs * 2, policy.maxDelayMs)
        made += 1
    }
}

/** `retryWithBackoff`, for Java: cancelling the future gives up. */
public fun <T> retryWithBackoffFuture(policy: RetryPolicy, retryable: Predicate<SemiontError>, attempt: Supplier<CompletionStage<T>>): CompletableFuture<T> =
    CoroutineScope(Dispatchers.Default).futureOf { retryWithBackoff(policy, retryable::test) { attempt.get().await() } }
