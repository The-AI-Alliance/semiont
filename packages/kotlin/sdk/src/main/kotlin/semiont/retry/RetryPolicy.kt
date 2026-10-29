package semiont.retry

/** How often something is tried, and how long is waited between tries: the delay doubles from `initialDelayMs` up to `maxDelayMs`. */
public data class RetryPolicy(
    /** How many times it is tried, the first among them. */
    public val attempts: Int,
    public val initialDelayMs: Long,
    public val maxDelayMs: Long,
)
