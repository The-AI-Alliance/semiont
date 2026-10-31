package semiont.cache

/**
 * The state of a live query: no value yet, a value, or a failure. A failure is
 * a state, never a throw: whoever observes the query lives through it, and the
 * next act on the query tries again. As JSON it is `{"status": "ready",
 * "value": …}`, the same state in every SDK.
 */
public sealed interface CacheState<out T> {
    /** Which state it is, as every SDK spells it. */
    public val status: String

    /** No value yet: a fetch may be in flight. */
    public data object Pending : CacheState<Nothing> {
        override val status: String get() = "pending"
    }

    /** A value, which may be the one shown while a newer one is fetched. */
    public data class Ready<out T>(public val value: T) : CacheState<T> {
        override val status: String get() = "ready"
    }

    /** No value, and the fetch for one failed, and failed again: `error` is what the second failed with, whatever it was. */
    public data class Failed(public val error: Exception) : CacheState<Nothing> {
        override val status: String get() = "failed"
    }
}
