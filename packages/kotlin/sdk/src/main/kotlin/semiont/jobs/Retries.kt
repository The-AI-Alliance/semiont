package semiont.jobs

import semiont.types.FailureClass

/**
 * Whether the queue runs a failure of this class again while its job has
 * retries left. A deterministic failure is not: the same request cannot
 * succeed a second time. Neither is an answer the provider withheld: it
 * withholds it from the same request again. A failure of no stated class is
 * retried as a transient one is.
 */
private fun retried(failureClass: FailureClass?): Boolean = when (failureClass) {
    null, FailureClass.Transient -> true
    FailureClass.Deterministic, FailureClass.Withheld -> false
}

/**
 * Whether a failed attempt is retried: exactly when its class is one the
 * queue retries and the job has retries left, on the record before the
 * failure is applied. The dispatcher's queue acts on it, and a held job
 * reports it on `job:fail` as `willRetry`, so the two never disagree:
 * specs/src/jobs/retry-cases.json is the table both answer alike.
 */
internal fun willRetryAfter(retryCount: Long, maxRetries: Long, failureClass: FailureClass?): Boolean = retried(failureClass) && retryCount < maxRetries
