package semiont.testing

import semiont.storage.SessionStorage

/** What every context of one shared storage reads and writes. */
private class Shared {
    val stored = LinkedHashMap<String, String>()
    val contexts = mutableListOf<SharedStorage>()
}

/**
 * A storage that more than one context writes, as two windows over one
 * browser's storage are: every context reads the same values, and each hears
 * what the others write, never what it writes itself. `context` is another
 * context over the same values.
 */
public class SharedStorage private constructor(private val shared: Shared) : SessionStorage {
    public constructor() : this(Shared())

    private val listeners = mutableListOf<(String, String?) -> Unit>()

    init {
        synchronized(shared) { shared.contexts += this }
    }

    /** Another context over the same values. */
    public fun context(): SharedStorage = SharedStorage(shared)

    override fun get(key: String): String? = synchronized(shared) { shared.stored[key] }

    override fun set(key: String, value: String): Unit = written(key) { value }

    override fun delete(key: String): Unit = written(key) { null }

    override fun update(key: String, change: (String?) -> String?): Unit = written(key, change)

    override fun subscribe(onChange: (key: String, value: String?) -> Unit): AutoCloseable {
        synchronized(shared) { listeners += onChange }
        return AutoCloseable { synchronized(shared) { listeners -= onChange } }
    }

    private fun written(key: String, change: (String?) -> String?) {
        val (after, told) = synchronized(shared) {
            val after = change(shared.stored[key])
            if (after == null) shared.stored.remove(key) else shared.stored[key] = after
            after to shared.contexts.filter { it !== this }.flatMap { it.listeners.toList() }
        }
        told.forEach { it(key, after) }
    }
}
