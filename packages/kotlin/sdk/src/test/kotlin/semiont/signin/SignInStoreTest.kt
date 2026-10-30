package semiont.signin

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import org.junit.jupiter.api.io.TempDir
import semiont.Spec
import semiont.http.renewKept
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.URLDecoder
import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

private const val ISSUER = "https://issuer.example"

/** A JWT of `claims`: what the SDK reads of a token is its claims, and it checks no signature. */
private fun jwt(claims: JsonObject): String {
    val encoded = Base64.getUrlEncoder().withoutPadding()
    return listOf("""{"alg":"RS256","typ":"JWT"}""", claims.toString()).joinToString(".") { encoded.encodeToString(it.toByteArray()) } + ".c2lnbmF0dXJl"
}

/** An issuer's token endpoint that answers each refresh grant with what a test gives it, and keeps every refresh token spent. */
private class Issuer : AutoCloseable {
    private val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
    val spent = CopyOnWriteArrayList<String>()

    @Volatile
    var issues: JsonObject = JsonObject(emptyMap())

    init {
        server.createContext("/token") { exchange ->
            val form = String(exchange.requestBody.readAllBytes()).split('&').associate { pair ->
                val (name, value) = pair.split('=', limit = 2)
                URLDecoder.decode(name, Charsets.UTF_8) to URLDecoder.decode(value, Charsets.UTF_8)
            }
            form["refresh_token"]?.let { spent += it }
            val body = issues.toString().toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.write(body)
            exchange.close()
        }
        server.start()
    }

    val tokenEndpoint: String get() = "http://127.0.0.1:${server.address.port}/token"

    override fun close(): Unit = server.stop(0)
}

/** The renewer's sign-in, on which another program acts between the renewal's read and its write: while its grant is in flight. */
private class Meanwhile(private val kept: SignInKept, private val act: suspend () -> Unit) : SignInKept by kept {
    override suspend fun held(): HeldSignIn? = kept.held().also { act() }
}

/** The renewer's sign-in, another program's, and the tokens the store holds for the stack. */
private class Stores(val renewer: SignInKept, val another: SignInKept, val holds: suspend () -> Pair<String, String>?)

/**
 * The sign-in store, held to the tables each SDK that reads it runs
 * (specs/src/sign-in-store/cases.json): where the launcher's state home is,
 * and what a renewal keeps while other programs renew and sign out. And the
 * lock every writer of the store takes.
 */
class SignInStoreTest {
    private val table = Spec.read("sign-in-store/cases.json").jsonObject

    private fun JsonObject.textOrNull(name: String): String? = get(name)?.takeUnless { it is JsonNull }?.jsonPrimitive?.content

    @TestFactory
    fun theStateHomeIsTheTables(): List<DynamicTest> = table.getValue("cases").jsonArray.map { it.jsonObject }.map { case ->
        DynamicTest.dynamicTest(case.getValue("why").jsonPrimitive.content) {
            val platform = when (case.getValue("os").jsonPrimitive.content) {
                "macos" -> Platform.MACOS
                "windows" -> Platform.WINDOWS
                else -> Platform.OTHER
            }
            val dir = stateDir(platform, home = case.textOrNull("home"), xdgStateHome = case.textOrNull("xdgStateHome"), localAppData = case.textOrNull("localAppData"))
            assertEquals(case.textOrNull("dir"), dir)
        }
    }

    private val stores: Map<String, (Path) -> Stores> = mapOf(
        "SignInStore" to { directory ->
            val path = directory.resolve("state").resolve(FILE_NAME)
            Stores(SignInStore(path).entry("local"), SignInStore(path).entry("local")) {
                (SignInStore(path).read()["local"] as? JsonObject)?.let { it.getValue("token").jsonPrimitive.content to it.getValue("refreshToken").jsonPrimitive.content }
            }
        },
        "MemorySignIn" to { _ ->
            val kept = MemorySignIn()
            Stores(kept, kept) { kept.held()?.let { it.access to it.refresh } }
        },
    )

    private val members = setOf("why", "kept", "holding", "meanwhile", "expired", "issues", "spends", "leaves", "gives")

    @TestFactory
    fun everyRenewalIsTheTables(): List<DynamicTest> = stores.flatMap { (store, made) ->
        table.getValue("renewals").jsonArray.map { it.jsonObject }.map { row ->
            DynamicTest.dynamicTest("$store: ${row.getValue("why").jsonPrimitive.content}") {
                assertEquals(members, row.keys)
                renewal(row, made(Files.createTempDirectory("sign-in-store")))
            }
        }
    }

    private fun renewal(row: JsonObject, stores: Stores) = runBlocking {
        val expired = row.getValue("expired").jsonArray.map { it.jsonPrimitive.content }.toSet()
        // Each access token the row names is a JWT of its own.
        val minted = mutableMapOf<String, String>()
        fun named(name: String): String = minted.getOrPut(name) {
            val now = System.currentTimeMillis() / 1000
            jwt(buildJsonObject {
                put("email", "alice@example.org")
                put("iss", ISSUER)
                put("exp", if (name in expired) now - 3600 else now + 3600)
                put("jti", name)
            })
        }
        fun nameOf(access: String?): String? = minted.entries.firstOrNull { it.value == access }?.key ?: access

        Issuer().use { issuer ->
            fun signIn(stated: JsonElement): HeldSignIn {
                stated as JsonObject
                return HeldSignIn(
                    access = named(stated.getValue("token").jsonPrimitive.content),
                    refresh = stated.getValue("refreshToken").jsonPrimitive.content,
                    clientId = SCRIPT_CLIENT_ID,
                    tokenEndpoint = issuer.tokenEndpoint,
                    revocationEndpoint = null,
                )
            }
            stores.another.keep(signIn(row.getValue("kept")))
            val meanwhile = row.getValue("meanwhile") as? JsonObject
            val act: suspend () -> Unit = {
                when (val does = meanwhile!!.getValue("does").jsonPrimitive.content) {
                    "renews" -> stores.another.keep(signIn(meanwhile.getValue("theirs")))
                    "signs-out" -> stores.another.forget()
                    else -> error("a row does what no store does: $does")
                }
            }
            val issues = row.getValue("issues").jsonObject
            issuer.issues = buildJsonObject {
                put("access_token", named(issues.getValue("token").jsonPrimitive.content))
                put("token_type", "Bearer")
                issues["refreshToken"]?.let { put("refresh_token", it) }
            }
            var renewing = stores.renewer
            when (meanwhile?.getValue("when")?.jsonPrimitive?.content) {
                null -> Unit
                "before" -> act()
                "during" -> renewing = Meanwhile(stores.renewer, act)
                else -> error("a row acts when no renewal does")
            }
            val holding = row.textOrNull("holding")

            val given = withTimeout(10_000) { renewKept(renewing, holding?.let(::named)) }

            assertEquals(listOfNotNull(row.textOrNull("spends")), issuer.spent.toList(), "the grants made")
            assertEquals(row.textOrNull("gives"), nameOf(given), "the access token given")
            val leaves = row.getValue("leaves") as? JsonObject
            val left = stores.holds()
            assertEquals(
                leaves?.let { it.getValue("token").jsonPrimitive.content to it.getValue("refreshToken").jsonPrimitive.content },
                left?.let { nameOf(it.first) to it.second },
                "what the store holds",
            )
        }
    }

    /** A process that takes the lock as the launcher takes it on this system, and holds it until it is told to let go. */
    private class Holding(lock: Path) : AutoCloseable {
        private val process: Process = ProcessBuilder(holderCommand(lock)).redirectError(ProcessBuilder.Redirect.INHERIT).start()

        init {
            val said = BufferedReader(InputStreamReader(process.inputStream)).readLine()
            check(said == "held") { "the holder said $said, not that it held the lock" }
        }

        /** Its input ends, and so does it: a process that has ended holds no lock. */
        fun letGo() {
            if (process.isAlive) {
                process.outputStream.close()
                process.waitFor(10, TimeUnit.SECONDS)
            }
        }

        override fun close() = letGo()

        companion object {
            // As specs/src/sign-in-store/README.md has every writer take it: `flock`, and on Windows the
            // launcher's own call, LockFileEx on the one byte at OffsetHigh 0x40000000.
            private val python = """
                import os, sys
                descriptor = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)
                if sys.platform == "win32":
                    import ctypes, msvcrt
                    from ctypes import wintypes
                    class Overlapped(ctypes.Structure):
                        _fields_ = [("Internal", ctypes.c_void_p), ("InternalHigh", ctypes.c_void_p),
                                    ("Offset", wintypes.DWORD), ("OffsetHigh", wintypes.DWORD), ("hEvent", wintypes.HANDLE)]
                    where = Overlapped(None, None, 0, 0x40000000, None)
                    handle = wintypes.HANDLE(msvcrt.get_osfhandle(descriptor))
                    if not ctypes.windll.kernel32.LockFileEx(handle, 0x2, 0, 1, 0, ctypes.byref(where)):
                        raise ctypes.WinError()
                else:
                    import fcntl
                    fcntl.flock(descriptor, fcntl.LOCK_EX)
                print("held", flush=True)
                sys.stdin.read()
            """.trimIndent()

            /** Linux's own flock(1) where the system has it, as the launcher's lock is flock(2); Python's elsewhere. */
            fun holderCommand(lock: Path): List<String> = when (thisPlatform()) {
                Platform.OTHER -> listOf("flock", "--exclusive", lock.toString(), "sh", "-c", "echo held; cat >/dev/null")
                Platform.MACOS -> listOf("python3", "-c", python, lock.toString())
                Platform.WINDOWS -> listOf("python", "-c", python, lock.toString())
            }
        }
    }

    @Test
    fun aChangeWaitsWhileAnotherProcessHoldsTheLock(@TempDir directory: Path) {
        val path = directory.resolve(FILE_NAME)
        Holding(directory.resolve("tokens.lock")).use { holder ->
            val changed = CompletableFuture.runAsync {
                SignInStore(path).change { document ->
                    document["n"] = JsonPrimitive(1)
                    true
                }
            }
            Thread.sleep(500)
            assertFalse(changed.isDone, "the change was made while another process held the lock")
            holder.letGo()
            changed.get(10, TimeUnit.SECONDS)
        }
        assertEquals(1, SignInStore(path).read().getValue("n").jsonPrimitive.int)
    }
}
