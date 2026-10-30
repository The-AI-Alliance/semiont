package semiont.signin

import java.io.IOException
import java.lang.foreign.Arena
import java.lang.foreign.FunctionDescriptor
import java.lang.foreign.Linker
import java.lang.foreign.MemoryLayout
import java.lang.foreign.ValueLayout
import java.lang.invoke.MethodHandle
import java.lang.invoke.VarHandle
import java.nio.channels.FileChannel
import java.nio.file.Path
import java.nio.file.StandardOpenOption

/** One hold of the store's lock, let go by `close`. */
internal fun interface Held : AutoCloseable {
    override fun close()
}

/**
 * The lock every writer of the store takes (specs/src/sign-in-store/README.md,
 * Writing it): `flock` on the lock file, and on Windows `LockFileEx` on its one
 * byte at `OffsetHigh 0x40000000`. The JVM's own file lock is not `flock` on
 * Linux, and the two ignore each other, so `flock` is called through the JDK's
 * foreign-function API; the application enables native access for it.
 */
internal object StoreLock {
    /** The byte the launcher locks on Windows, far past anything a lock file holds. */
    private const val WINDOWS_BYTE = 0x40000000L shl 32

    fun hold(lock: Path): Held = if (thisPlatform() == Platform.WINDOWS) windows(lock) else Flock.hold(lock)

    private fun windows(lock: Path): Held {
        val channel = FileChannel.open(lock, StandardOpenOption.CREATE, StandardOpenOption.WRITE)
        try {
            channel.lock(WINDOWS_BYTE, 1, false)
        } catch (error: IOException) {
            channel.close()
            throw error
        }
        // Closing the channel lets the lock go.
        return Held { channel.close() }
    }
}

/** `flock(2)` and the two calls around it, as Linux and macOS have them. */
private object Flock {
    private const val O_RDWR = 2
    private const val LOCK_EX = 2
    private const val EINTR = 4

    private val linker = Linker.nativeLinker()
    private val errno = Linker.Option.captureCallState("errno")
    private val captured: MemoryLayout = Linker.Option.captureStateLayout()
    private val errnoOf: VarHandle = captured.varHandle(MemoryLayout.PathElement.groupElement("errno"))

    private fun function(name: String, descriptor: FunctionDescriptor, vararg options: Linker.Option): MethodHandle =
        linker.downcallHandle(linker.defaultLookup().find(name).orElseThrow { IOException("this system has no $name") }, descriptor, *options)

    // `open` is variadic; called with no mode it passes none, and the file is made beforehand.
    private val open = function("open", FunctionDescriptor.of(ValueLayout.JAVA_INT, ValueLayout.ADDRESS, ValueLayout.JAVA_INT), errno)
    private val flock = function("flock", FunctionDescriptor.of(ValueLayout.JAVA_INT, ValueLayout.JAVA_INT, ValueLayout.JAVA_INT), errno)
    private val close = function("close", FunctionDescriptor.of(ValueLayout.JAVA_INT, ValueLayout.JAVA_INT))

    fun hold(lock: Path): Held {
        val descriptor = Arena.ofConfined().use { arena ->
            val state = arena.allocate(captured)
            val opened = open.invoke(state, arena.allocateFrom(lock.toString()), O_RDWR) as Int
            if (opened < 0) throw IOException("could not open $lock (errno ${errnoOf.get(state, 0L) as Int})")
            while (true) {
                if (flock.invoke(state, opened, LOCK_EX) as Int == 0) break
                val failed = errnoOf.get(state, 0L) as Int
                if (failed != EINTR) {
                    close.invoke(opened)
                    throw IOException("could not lock $lock (errno $failed)")
                }
            }
            opened
        }
        // Closing the descriptor lets the lock go.
        return Held { close.invoke(descriptor) }
    }
}
