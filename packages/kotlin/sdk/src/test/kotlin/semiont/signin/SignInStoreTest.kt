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
import org.junit.jupiter.api.Assertions.assertTrue
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

            /**
             * Linux's own flock(1) where the system has it, as the launcher's lock is flock(2); Python's elsewhere,
             * its script in a file of its own: Windows' command line would lose the quotes of a script passed inline.
             */
            fun holderCommand(lock: Path): List<String> {
                if (thisPlatform() == Platform.OTHER) return listOf("flock", "--exclusive", lock.toString(), "sh", "-c", "echo held; cat >/dev/null")
                val script = Files.createTempFile("holder", ".py").also { Files.writeString(it, python) }
                return listOf(if (thisPlatform() == Platform.WINDOWS) "python" else "python3", script.toString(), lock.toString())
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

    // ── What the store keeps, as the launcher keeps it ───────────────────

    private fun signedIn(n: Int, email: String = "alice@example.org"): String {
        val now = System.currentTimeMillis() / 1000
        return jwt(buildJsonObject {
            put("email", email)
            put("iss", ISSUER)
            put("exp", now + 3600)
            put("jti", "access-$n")
        })
    }

    private fun held(access: String, refresh: String = "refresh-1", revocation: String? = "$ISSUER/revoke") =
        HeldSignIn(access, refresh, SCRIPT_CLIENT_ID, "$ISSUER/token", revocation)

    private fun entryOf(path: Path, key: String): JsonObject = SignInStore(path).read().getValue(key).jsonObject

    /**
     * The user this process runs as, and the access list of `path` as Windows writes it out (SDDL), each as PowerShell reads it.
     * The user is named as an access list written out names it: by its SID, or by an abbreviation (the built-in administrator
     * is `LA`). Windows PowerShell is given no `PSModulePath`: the one PowerShell 7 sets, which a CI step's shell hands down,
     * leads it to modules it cannot load.
     */
    private fun accessListOf(path: Path): Pair<String, String> {
        val script = "[Security.AccessControl.RawSecurityDescriptor]::new('O:' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)" +
            ".GetSddlForm('Owner').Substring(2); " +
            "(Get-Acl -LiteralPath '${path.toString().replace("'", "''")}').GetSecurityDescriptorSddlForm('Access')"
        val command = ProcessBuilder("powershell", "-NoProfile", "-NonInteractive", "-Command", script).redirectErrorStream(true)
        command.environment().remove("PSModulePath")
        val process = command.start()
        val said = process.inputStream.bufferedReader().readText().split(Regex("""\s+""")).filter { it.isNotEmpty() }
        assertEquals(0, process.waitFor(), "PowerShell said $said")
        assertEquals(2, said.size, "PowerShell said $said")
        return said[0] to said[1]
    }

    /**
     * An access list's flags (`D:PAI`) and its entries, sorted. PowerShell reads a list through .NET, which writes the entries a
     * list sets itself in an order of its own (by SID), and the order of entries that each allow does not change what they allow.
     */
    private fun entriesOf(list: String): Pair<String, List<String>> {
        val flags = list.substringBefore("(")
        return flags to list.drop(flags.length).split(")").filter { it.isNotEmpty() }.map { "$it)" }.sorted()
    }

    @Test
    fun theEntryThisSdkWritesIsTheSchemas() {
        val schema = Spec.read("sign-in-store/SignIn.json").jsonObject
        val descriptor = semiont.types.SignIn.serializer().descriptor
        val written = (0 until descriptor.elementsCount).map { descriptor.getElementName(it) }.toSet()
        assertEquals(schema.getValue("properties").jsonObject.keys, written)
        val required = (0 until descriptor.elementsCount).filter { !descriptor.isElementOptional(it) }.map { descriptor.getElementName(it) }.toSet()
        assertEquals(schema.getValue("required").jsonArray.map { it.jsonPrimitive.content }.toSet(), required)
    }

    @Test
    fun aStoreWhoseFileIsNotThereHoldsNothingAndReadingItMakesNothing(@TempDir directory: Path) = runBlocking {
        val path = directory.resolve("state").resolve(FILE_NAME)
        assertEquals(JsonObject(emptyMap()), SignInStore(path).read())
        assertEquals(null, SignInStore(path).entry("local").held())
        assertFalse(Files.exists(path.parent), "a reader that only reads writes nothing, and takes no lock")
    }

    @Test
    fun aSignInIsKeptAsTheLauncherKeepsOne(@TempDir directory: Path) = runBlocking {
        val path = directory.resolve("state").resolve(FILE_NAME)
        val access = signedIn(1)
        SignInStore(path).entry("local").keep(held(access))
        val kept = entryOf(path, "local")
        assertEquals(access, kept.getValue("token").jsonPrimitive.content)
        assertEquals("refresh-1", kept.getValue("refreshToken").jsonPrimitive.content)
        // Who signed in, and at which issuer, as the access token names them.
        assertEquals("alice@example.org" to ISSUER, kept.getValue("email").jsonPrimitive.content to kept.getValue("issuer").jsonPrimitive.content)
        assertEquals("$ISSUER/token" to "$ISSUER/revoke", kept.getValue("tokenEndpoint").jsonPrimitive.content to kept.getValue("revocationEndpoint").jsonPrimitive.content)
        // RFC 3339 in UTC, to the second.
        for (name in listOf("obtainedAt", "expiresAt")) {
            val stated = kept.getValue(name).jsonPrimitive.content
            assertTrue(Regex("""\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z""").matches(stated), "$name is $stated")
        }
        assertEquals(held(access), SignInStore(path).entry("local").held())
        // The file holds bearer credentials: its owner's alone, and so is its lock, in a directory kept to its owner as the
        // launcher keeps its state home. Nothing else is left beside it.
        if ("posix" in path.fileSystem.supportedFileAttributeViews()) {
            assertEquals("rwx------", java.nio.file.attribute.PosixFilePermissions.toString(Files.getPosixFilePermissions(path.parent)))
            assertEquals("rw-------", java.nio.file.attribute.PosixFilePermissions.toString(Files.getPosixFilePermissions(path)))
            assertEquals("rw-------", java.nio.file.attribute.PosixFilePermissions.toString(Files.getPosixFilePermissions(path.resolveSibling("tokens.lock"))))
        } else {
            // The launcher's access list: the user, the system and the administrators, handed down, and nothing inherited from above.
            val (user, list) = accessListOf(path.parent)
            fun ownerOnly(inherit: String) = listOf(user, "SY", "BA").map { "(A;$inherit;FA;;;$it)" }.sorted()
            val (flags, entries) = entriesOf(list)
            assertTrue(flags in setOf("D:PAI", "D:P") && entries == ownerOnly("OICI"), "the state home's access list is $list, not its owner's ($user) alone")
            for (made in listOf(path, path.resolveSibling("tokens.lock"))) {
                val (_, inherited) = accessListOf(made)
                val (madeFlags, madeEntries) = entriesOf(inherited)
                assertTrue(
                    madeFlags in setOf("D:AI", "D:") && madeEntries == ownerOnly("ID"),
                    "$made's access list is $inherited, not the one its directory hands down to its owner ($user)",
                )
            }
        }
        assertEquals(listOf("tokens.json", "tokens.lock"), Files.list(path.parent).use { files -> files.map { it.fileName.toString() }.sorted().toList() })
        assertTrue(Files.readString(path).endsWith("}\n"))
    }

    @Test
    fun anIssuerWithNoRevocationEndpointAndATokenWithNoExpiryLeaveThoseOut(@TempDir directory: Path) = runBlocking {
        val path = directory.resolve(FILE_NAME)
        SignInStore(path).entry("local").keep(held(jwt(buildJsonObject { put("email", "alice@example.org"); put("iss", ISSUER) }), revocation = null))
        assertFalse("revocationEndpoint" in entryOf(path, "local"))
        assertFalse("expiresAt" in entryOf(path, "local"))
    }

    @Test
    fun whatIsNoSignInIsNotKept(@TempDir directory: Path) = runBlocking {
        val path = directory.resolve(FILE_NAME)
        val kept = SignInStore(path).entry("local")
        // What another client was issued would be renewed here as the wrong client.
        val wrongClient = org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException::class.java) {
            runBlocking { kept.keep(HeldSignIn(signedIn(1), "r", "semiont-browser", "$ISSUER/token", null)) }
        }
        assertTrue(wrongClient.message!!.contains("semiont-browser"))
        // A gateway admits no token from an issuer it does not trust.
        val refused = org.junit.jupiter.api.Assertions.assertThrows(semiont.errors.SignInError::class.java) {
            runBlocking { kept.keep(held(jwt(buildJsonObject { put("email", "alice@example.org") }))) }
        }
        assertEquals("exchange", refused.code)
        assertTrue(refused.message!!.contains("names no issuer"), refused.message)
        assertFalse(Files.exists(path))
    }

    @Test
    fun aTokenThatNamesNoAddressIsKeptWithoutOne(@TempDir directory: Path) = runBlocking {
        val path = directory.resolve(FILE_NAME)
        val kept = SignInStore(path).entry("local")
        val unaddressed = held(jwt(buildJsonObject { put("iss", ISSUER); put("sub", "an-account") }))
        kept.keep(unaddressed)
        assertEquals(ISSUER, entryOf(path, "local").getValue("issuer").jsonPrimitive.content)
        assertFalse("email" in entryOf(path, "local"))
        assertEquals(unaddressed, kept.held())
        // A renewal whose token names an address keeps none: the sign-in learned none.
        val renewed = signedIn(2)
        assertEquals(renewed, kept.renewed(unaddressed, renewed, "refresh-2"))
        assertFalse("email" in entryOf(path, "local"))
    }

    @Test
    fun aRenewalKeepsWhoSignedInAndWhereAndChangesTheTokens(@TempDir directory: Path) = runBlocking {
        val path = directory.resolve(FILE_NAME)
        val kept = SignInStore(path).entry("local")
        val first = held(signedIn(1))
        kept.keep(first)
        val before = entryOf(path, "local")
        // The renewed token names another address: the entry keeps the one the sign-in learned.
        val renewed = signedIn(2, email = "alice@elsewhere.example")
        assertEquals(renewed, kept.renewed(first, renewed, "refresh-2"))
        val after = entryOf(path, "local")
        assertEquals(renewed to "refresh-2", after.getValue("token").jsonPrimitive.content to after.getValue("refreshToken").jsonPrimitive.content)
        for (name in listOf("email", "issuer", "tokenEndpoint", "revocationEndpoint")) assertEquals(before[name], after[name], name)
        assertEquals(held(renewed, "refresh-2"), kept.held())
    }

    @Test
    fun forgettingWhatIsNotKeptChangesNothing(@TempDir directory: Path) = runBlocking {
        val path = directory.resolve(FILE_NAME)
        val kept = SignInStore(path).entry("local")
        kept.keep(held(signedIn(1)))
        kept.forget()
        assertEquals(JsonObject(emptyMap()), SignInStore(path).read())
        val wrote = Files.getLastModifiedTime(path)
        Thread.sleep(20)
        kept.forget()
        assertEquals(wrote, Files.getLastModifiedTime(path))
    }

    @Test
    fun anEntryWithNoRefreshTokenIsNoSignInToHold(@TempDir directory: Path) = runBlocking {
        val path = directory.resolve(FILE_NAME)
        Files.writeString(path, """{"local": {"token": "${signedIn(1)}", "email": "a@example.org", "obtainedAt": "x", "issuer": "$ISSUER", "tokenEndpoint": "t"}}""")
        assertEquals(null, SignInStore(path).entry("local").held())
    }

    @Test
    fun whatTheFileHoldsThatIsNotThisSignInIsWrittenBackAsItWas(@TempDir directory: Path) = runBlocking {
        val path = directory.resolve(FILE_NAME)
        val store = SignInStore(path)
        store.entry("codespace:owner/name").keep(held(signedIn(7)))
        val others = buildJsonObject {
            put("codespace:owner/name", entryOf(path, "codespace:owner/name"))
            // What a later release wrote, and this one does not understand.
            put("later", kotlinx.serialization.json.Json.parseToJsonElement("""{"shape": ["unknown", 1, null], "nested": {"deep": true}}"""))
            put("not-even-an-object", 3)
        }
        Files.writeString(path, others.toString())
        val first = held(signedIn(1))
        store.entry("local").keep(first)
        val renewed = signedIn(2)
        assertEquals(renewed, store.entry("local").renewed(first, renewed, "refresh-2"))
        assertEquals(others, JsonObject(store.read() - "local"))
        // What is not a sign-in is none to hold, and is not renewed into one.
        assertEquals(null, store.entry("later").held())
        assertEquals(null, store.entry("later").renewed(held(signedIn(3)), signedIn(3), "refresh-3"))
        store.entry("local").forget()
        assertEquals(others, store.read())
    }
}
