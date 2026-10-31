package semiont.signin

import java.io.IOException
import java.lang.foreign.Arena
import java.lang.foreign.FunctionDescriptor
import java.lang.foreign.Linker
import java.lang.foreign.MemoryLayout
import java.lang.foreign.MemorySegment
import java.lang.foreign.SymbolLookup
import java.lang.foreign.ValueLayout.ADDRESS
import java.lang.foreign.ValueLayout.JAVA_INT
import java.lang.invoke.MethodHandle
import java.lang.invoke.VarHandle
import java.nio.charset.StandardCharsets
import java.nio.file.Path

/**
 * The access list the launcher gives its state home, on Windows: the user this
 * process runs as, the system and the administrators, each with full access,
 * handed down to everything made in the directory from then on, and nothing
 * inherited from above. A mode keeps nobody out on Windows; the access list is
 * what does. The JDK's own view of an access list names a principal by its
 * account name, which Windows writes in the system's language, and cannot keep
 * a list from inheriting, so the list is set through the JDK's foreign-function
 * API, as the launcher sets it.
 */
internal object OwnerOnly {
    /** This process's token, as `GetCurrentProcessToken` names it. */
    private val currentProcessToken: MemorySegment = MemorySegment.ofAddress(-4L)
    private const val TOKEN_USER = 1
    private const val SDDL_REVISION_1 = 1
    private const val SE_FILE_OBJECT = 1
    private const val DACL_SECURITY_INFORMATION = 0x00000004
    private const val PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000.toInt()

    private val linker = Linker.nativeLinker()
    private val lastError = Linker.Option.captureCallState("GetLastError")
    private val captured: MemoryLayout = Linker.Option.captureStateLayout()
    private val lastErrorOf: VarHandle = captured.varHandle(MemoryLayout.PathElement.groupElement("GetLastError"))
    private val advapi32 = SymbolLookup.libraryLookup("advapi32", Arena.global())
    private val kernel32 = SymbolLookup.libraryLookup("kernel32", Arena.global())

    private fun function(library: SymbolLookup, name: String, descriptor: FunctionDescriptor, vararg options: Linker.Option): MethodHandle =
        linker.downcallHandle(library.find(name).orElseThrow { IOException("this system has no $name") }, descriptor, *options)

    private val getTokenInformation = function(advapi32, "GetTokenInformation", FunctionDescriptor.of(JAVA_INT, ADDRESS, JAVA_INT, ADDRESS, JAVA_INT, ADDRESS), lastError)
    private val convertSidToStringSid = function(advapi32, "ConvertSidToStringSidW", FunctionDescriptor.of(JAVA_INT, ADDRESS, ADDRESS), lastError)
    private val getNamedSecurityInfo = function(
        advapi32,
        "GetNamedSecurityInfoW",
        FunctionDescriptor.of(JAVA_INT, ADDRESS, JAVA_INT, JAVA_INT, ADDRESS, ADDRESS, ADDRESS, ADDRESS, ADDRESS),
    )
    private val convertSecurityDescriptorToString = function(
        advapi32,
        "ConvertSecurityDescriptorToStringSecurityDescriptorW",
        FunctionDescriptor.of(JAVA_INT, ADDRESS, JAVA_INT, JAVA_INT, ADDRESS, ADDRESS),
        lastError,
    )
    private val convertStringSecurityDescriptor = function(
        advapi32,
        "ConvertStringSecurityDescriptorToSecurityDescriptorW",
        FunctionDescriptor.of(JAVA_INT, ADDRESS, JAVA_INT, ADDRESS, ADDRESS),
        lastError,
    )
    private val getSecurityDescriptorDacl = function(advapi32, "GetSecurityDescriptorDacl", FunctionDescriptor.of(JAVA_INT, ADDRESS, ADDRESS, ADDRESS, ADDRESS), lastError)
    private val setNamedSecurityInfo = function(advapi32, "SetNamedSecurityInfoW", FunctionDescriptor.of(JAVA_INT, ADDRESS, JAVA_INT, JAVA_INT, ADDRESS, ADDRESS, ADDRESS, ADDRESS))
    private val localFree = function(kernel32, "LocalFree", FunctionDescriptor.of(ADDRESS, ADDRESS))

    private fun failed(call: String, state: MemorySegment): Nothing = throw IOException("$call failed (error ${lastErrorOf.get(state, 0L) as Int})")

    /** Text the system wrote and allocated, taken and freed. */
    private fun taken(text: MemorySegment): String =
        try {
            text.reinterpret(Long.MAX_VALUE).getString(0L, StandardCharsets.UTF_16LE)
        } finally {
            localFree.invoke(text)
        }

    /** The access list `descriptor` holds, as Windows writes it out (SDDL). */
    private fun written(arena: Arena, state: MemorySegment, descriptor: MemorySegment): String {
        val text = arena.allocate(ADDRESS)
        if (convertSecurityDescriptorToString.invoke(state, descriptor, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, text, MemorySegment.NULL) as Int == 0) {
            failed("ConvertSecurityDescriptorToStringSecurityDescriptorW", state)
        }
        return taken(text.get(ADDRESS, 0L))
    }

    /**
     * An access list as Windows writes it out, with its entries sorted: entries that each allow mean the same in any order, and a
     * list's own entries need not be read back in the order they were set.
     */
    private fun inAnyOrder(list: String): String {
        val flags = list.substringBefore("(")
        return flags + list.drop(flags.length).split(")").filter { it.isNotEmpty() }.sorted().joinToString("") { "$it)" }
    }

    /**
     * Keep `directory`, and everything made in it from then on, to its owner.
     * A directory that has the list already is left as it is: setting a list
     * hands it down to everything beneath, which in a state home is no small
     * walk. The two lists are compared as Windows writes each out, which names
     * some users by an abbreviation (the built-in administrator is `LA`)
     * rather than by their SID, and with their entries in any order.
     */
    fun keep(directory: Path): Unit = Arena.ofConfined().use { arena ->
        val state = arena.allocate(captured)
        val size = arena.allocate(JAVA_INT)
        getTokenInformation.invoke(state, currentProcessToken, TOKEN_USER, MemorySegment.NULL, 0, size)
        // A TOKEN_USER begins with the user's SID_AND_ATTRIBUTES, which begins with the SID.
        val user = arena.allocate(size.get(JAVA_INT, 0L).toLong(), ADDRESS.byteAlignment())
        if (getTokenInformation.invoke(state, currentProcessToken, TOKEN_USER, user, size.get(JAVA_INT, 0L), size) as Int == 0) failed("GetTokenInformation", state)
        val named = arena.allocate(ADDRESS)
        if (convertSidToStringSid.invoke(state, user.get(ADDRESS, 0L), named) as Int == 0) failed("ConvertSidToStringSidW", state)
        val list = "D:PAI(A;OICI;FA;;;${taken(named.get(ADDRESS, 0L))})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
        val made = arena.allocate(ADDRESS)
        if (convertStringSecurityDescriptor.invoke(state, arena.allocateFrom(list, StandardCharsets.UTF_16LE), SDDL_REVISION_1, made, MemorySegment.NULL) as Int == 0) {
            failed("ConvertStringSecurityDescriptorToSecurityDescriptorW", state)
        }
        val descriptor = made.get(ADDRESS, 0L)
        try {
            val name = arena.allocateFrom(directory.toString(), StandardCharsets.UTF_16LE)
            val dacl = arena.allocate(ADDRESS)
            val held = arena.allocate(ADDRESS)
            val unread = getNamedSecurityInfo.invoke(name, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, MemorySegment.NULL, MemorySegment.NULL, dacl, MemorySegment.NULL, held) as Int
            if (unread != 0) throw IOException("could not read the access list of $directory (error $unread)")
            val has = try {
                written(arena, state, held.get(ADDRESS, 0L))
            } finally {
                localFree.invoke(held.get(ADDRESS, 0L))
            }
            if (inAnyOrder(has) == inAnyOrder(written(arena, state, descriptor))) return@use

            val present = arena.allocate(JAVA_INT)
            val defaulted = arena.allocate(JAVA_INT)
            if (getSecurityDescriptorDacl.invoke(state, descriptor, present, dacl, defaulted) as Int == 0) failed("GetSecurityDescriptorDacl", state)
            val refused = setNamedSecurityInfo.invoke(
                name,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION or PROTECTED_DACL_SECURITY_INFORMATION,
                MemorySegment.NULL,
                MemorySegment.NULL,
                dacl.get(ADDRESS, 0L),
                MemorySegment.NULL,
            ) as Int
            if (refused != 0) throw IOException("could not keep $directory to its owner (error $refused)")
        } finally {
            localFree.invoke(descriptor)
        }
    }
}
