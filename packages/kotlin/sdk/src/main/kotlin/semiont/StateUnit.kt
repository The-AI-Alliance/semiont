package semiont

/**
 * A unit of what a host shows: state it reads, as `Watched` values, and
 * members that change it. Closing it ends every reader of it, and nothing is
 * told after; closing it twice is closing it once.
 */
public interface StateUnit : AutoCloseable {
    override fun close()
}
