@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)

package semiont.signin

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import semiont.errors.SignInError
import semiont.errors.SignInErrorCode
import semiont.session.textClaim
import semiont.session.tokenExpiry
import semiont.types.SignIn
import semiont.types.wireJson
import java.nio.file.FileSystems
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** The document as it is written: two spaces to a level, as every writer of it writes it. */
private val pretty = Json {
    prettyPrint = true
    prettyPrintIndent = "  "
}

/** Whether this system's files have POSIX permissions, so a credential's file is made readable by its owner alone. */
private val posix = "posix" in FileSystems.getDefault().supportedFileAttributeViews()

/**
 * One change at a time from this process, by the lock file's path: the file
 * lock is between processes, and two holds of one process on one file do not
 * exclude each other on every system.
 */
private val turns = ConcurrentHashMap<Path, ReentrantLock>()

/** A time as RFC 3339 in UTC, to the second. */
private fun rfc3339(seconds: Double): String = DateTimeFormatter.ISO_INSTANT.format(Instant.ofEpochSecond(seconds.toLong()))

private fun now(): Double = System.currentTimeMillis() / 1000.0

/**
 * The sign-in store in the file at `path`: `FILE_NAME` in `stateDir` for the
 * launcher's (specs/src/sign-in-store/README.md). Every change is a read, a
 * change and a write under the lock every writer takes, and the write is made
 * beside the file and renamed over it, so no reader sees half a document and
 * no credential is left in a stray file.
 */
public class SignInStore(path: Path) {
    private val path: Path = path.toAbsolutePath().normalize()
    private val lock: Path = this.path.resolveSibling(LOCK_NAME)

    /** Where the sign-in of the stack `key` is kept. */
    public fun entry(key: String): SignInKept = Entry(this, key)

    /** The document as it is now. A file that is not there holds nothing. */
    public fun read(): JsonObject {
        val text = try {
            Files.readString(path)
        } catch (_: NoSuchFileException) {
            return JsonObject(emptyMap())
        }
        return Json.parseToJsonElement(text) as? JsonObject ?: throw SerializationException("$path holds no JSON object")
    }

    /** Change the document as one step: read it, change it, and write it when `change` says it changed. */
    public fun change(change: (MutableMap<String, JsonElement>) -> Boolean) {
        Files.createDirectories(path.parent)
        turns.computeIfAbsent(lock) { ReentrantLock() }.withLock {
            if (Files.notExists(lock)) made(lock)
            StoreLock.hold(lock).use {
                val document = read().toMutableMap()
                if (change(document)) write(JsonObject(document))
            }
        }
    }

    /** A file made readable and writable by its owner alone, where the system says who may. */
    private fun made(file: Path) {
        if (posix) {
            Files.newByteChannel(
                file,
                setOf(StandardOpenOption.CREATE, StandardOpenOption.WRITE),
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")),
            ).close()
        } else {
            Files.newByteChannel(file, StandardOpenOption.CREATE, StandardOpenOption.WRITE).close()
        }
    }

    private fun write(document: JsonObject) {
        val beside = path.resolveSibling("${path.fileName}.tmp")
        try {
            Files.deleteIfExists(beside)
            made(beside)
            Files.writeString(beside, pretty.encodeToString(JsonObject.serializer(), document) + "\n", StandardOpenOption.TRUNCATE_EXISTING)
            Files.move(beside, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (error: Throwable) {
            Files.deleteIfExists(beside)
            throw error
        }
    }
}

/** A member of the document as a sign-in. One that is not a sign-in is none. */
private fun signInOf(entry: JsonElement?): SignIn? {
    if (entry == null) return null
    return try {
        wireJson.decodeFromJsonElement(SignIn.serializer(), entry)
    } catch (_: IllegalArgumentException) {
        null
    }
}

/** One stack's sign-in, in the store's file. Its file is read and written off the caller's thread. */
private class Entry(private val store: SignInStore, private val key: String) : SignInKept {
    private fun heldNow(): HeldSignIn? {
        val entry = signInOf(store.read()[key])
        // A sign-in with no refresh token is none: a session that cannot be renewed does not outlive its first access token.
        val refresh = entry?.refreshToken?.takeIf { it.isNotEmpty() } ?: return null
        return HeldSignIn(entry.token, refresh, SCRIPT_CLIENT_ID, entry.tokenEndpoint, entry.revocationEndpoint)
    }

    /** The entry a renewal leaves: who signed in, at which issuer and where it is renewed stay as the sign-in learned them. */
    private fun written(before: SignIn, access: String, refresh: String): JsonElement = wireJson.encodeToJsonElement(
        SignIn.serializer(),
        SignIn(
            token = access,
            refreshToken = refresh,
            email = before.email,
            obtainedAt = rfc3339(now()),
            expiresAt = tokenExpiry(access)?.let(::rfc3339),
            issuer = before.issuer,
            tokenEndpoint = before.tokenEndpoint,
            revocationEndpoint = before.revocationEndpoint,
        ),
    )

    override suspend fun held(): HeldSignIn? = withContext(Dispatchers.IO) { heldNow() }

    override suspend fun keep(signIn: HeldSignIn) {
        require(signIn.clientId == SCRIPT_CLIENT_ID) {
            "the sign-in store keeps what the client $SCRIPT_CLIENT_ID was issued, and this was issued to ${signIn.clientId}"
        }
        // A gateway admits no token that names no address, and none from an issuer it does not trust: a token that lacks either is no sign-in.
        val email = textClaim(signIn.access, "email")
        val issuer = textClaim(signIn.access, "iss")
        if (email == null || issuer == null) {
            throw SignInError(SignInErrorCode.Exchange, "The sign-in to $key was not kept: its access token names no ${if (email == null) "email" else "issuer"}")
        }
        val learned = SignIn(
            token = signIn.access,
            email = email,
            obtainedAt = rfc3339(now()),
            issuer = issuer,
            tokenEndpoint = signIn.tokenEndpoint,
            revocationEndpoint = signIn.revocationEndpoint,
        )
        withContext(Dispatchers.IO) {
            store.change { document ->
                document[key] = written(learned, signIn.access, signIn.refresh)
                true
            }
        }
    }

    override suspend fun renewed(read: HeldSignIn, access: String, refresh: String): String? = withContext(Dispatchers.IO) {
        var given: String? = null
        store.change { document ->
            val before = signInOf(document[key]) ?: return@change false
            // Another program renewed, or signed in again, while this renewal's grant was in flight: its tokens stand.
            // The refresh token alone does not tell, since an issuer that rotates none leaves it as it was.
            if (before.token != read.access || before.refreshToken != read.refresh) {
                given = before.token
                return@change false
            }
            document[key] = written(before, access, refresh)
            given = access
            true
        }
        given
    }

    override suspend fun forget(): Unit = withContext(Dispatchers.IO) { store.change { document -> document.remove(key) != null } }
}
