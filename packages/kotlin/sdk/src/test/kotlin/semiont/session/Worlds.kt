@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package semiont.session

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import semiont.Recording
import semiont.SemiontClient
import semiont.errors.SemiontError
import semiont.errors.SessionError
import semiont.errors.SignInError
import semiont.errors.SignInErrorCode
import semiont.errors.TransportError
import semiont.signin.HeldSignIn
import semiont.signin.MemorySignIn
import semiont.signin.SCRIPT_CLIENT_ID
import semiont.signin.SignInKept
import semiont.types.HttpEndpoint
import semiont.types.HttpEndpointProtocol
import semiont.types.KbTarget
import semiont.types.UserResponse
import semiont.types.wireJson
import java.io.IOException
import java.util.Base64
import kotlin.random.Random

internal fun jwt(claims: JsonObject): String {
    val encoded = Base64.getUrlEncoder().withoutPadding()
    return listOf("""{"alg":"RS256","typ":"JWT"}""", claims.toString()).joinToString(".") { encoded.encodeToString(it.toByteArray()) } + ".c2lnbmF0dXJl"
}

/** A token that lives `lifetime` seconds from now, the `n`th of its kind. */
internal fun token(lifetime: Long, n: Int): String {
    val now = System.currentTimeMillis() / 1000
    return jwt(buildJsonObject {
        put("iat", now)
        put("exp", now + lifetime)
        put("jti", "token-$n")
    })
}

internal fun expired(): String = token(-3600, 99)

internal val alice: UserResponse = wireJson.decodeFromString(
    UserResponse.serializer(),
    """{"did":"did:web:example.org:users:alice","email":"alice@example.org","name":"Alice","image":null,"domain":"example.org","isAdmin":false,"isModerator":false,"termsAcceptedAt":null}""",
)

internal fun unauthorized() = TransportError.ofStatus("HTTP 401", 401, null)

internal fun refusedByTheIssuer() = SignInError(SignInErrorCode.Exchange, "The issuer refused the token request (invalid_grant: Token is not active)", 400)

internal fun unansweredByTheIssuer() = SignInError(SignInErrorCode.Exchange, "The issuer did not answer: the network is down")

internal val TARGET = KbTarget(id = "kb-alpha", label = "Alpha", endpoint = HttpEndpoint(host = "localhost", port = 4000, protocol = HttpEndpointProtocol.Http))

/**
 * A session's surroundings, and a record of what the session did to them.
 * `renewals` is what the issuer answers, in order: a token, a failure it
 * throws, or none; none once they are spent. `validations` is what the
 * gateway says of a token, in order: who it is, or a failure; Alice once they
 * are spent.
 */
internal class SessionWorld(kept: String? = null, renewals: List<Any?> = emptyList(), validations: List<Any> = emptyList()) {
    val kept = MemorySignIn(kept?.let { HeldSignIn(it, "a-refresh-token", SCRIPT_CLIENT_ID, "https://issuer.test/token", null, null) })

    /** Whether the session's reads of its sign-in fail, as a store's that cannot be read do. What is kept stays kept. */
    @Volatile
    var unreadable = false

    /** The sign-in as the session holds it: `kept`, read only while it is not `unreadable`. */
    private val held: SignInKept = object : SignInKept by this@SessionWorld.kept {
        override suspend fun held(): HeldSignIn? {
            if (unreadable) throw IOException("the sign-in cannot be read")
            return this@SessionWorld.kept.held()
        }
    }
    val token = MutableStateFlow<String?>(null)
    private val renewalsLeft = ArrayDeque(renewals)
    var renewed = 0

    /** The token each renewal was handed, in order: the one the session held as it renewed. */
    val handed = mutableListOf<String?>()

    /** When each renewal was asked for, by the clock given, when one is. */
    val renewedAt = mutableListOf<Long>()
    var clock: (() -> Long)? = null
    private val validationsLeft = ArrayDeque(validations)
    val validated = mutableListOf<String>()

    /** Who the gateway last said a token is. */
    var answered: UserResponse? = null
    val told = mutableListOf<SessionEndReason>()

    /** What the session said of its own on its errors stream, in order, each as it was said. */
    val errors = mutableListOf<SessionError>()

    suspend fun refresh(holding: String?): String? {
        renewed += 1
        handed += holding
        clock?.let { renewedAt += it() }
        return when (val answer = renewalsLeft.removeFirstOrNull()) {
            is SignInError -> throw answer
            else -> answer as String?
        }
    }

    suspend fun validate(asked: String): UserResponse {
        validated += asked
        return when (val answer = validationsLeft.removeFirstOrNull() ?: alice) {
            is SemiontError -> throw answer
            else -> (answer as UserResponse).also { answered = it }
        }
    }

    /**
     * A session over a client of its own, on the test's dispatcher and clock, that renews and asks as given: as this
     * world scripts, unless told otherwise. What it says is read from its errors stream from before it starts, each
     * as it is said, by a reader that is no child of the test, so a stream the session's close does not end holds
     * no test open.
     */
    suspend fun session(
        renew: (suspend (String?) -> String?)? = { refresh(it) },
        asking: (suspend (String) -> UserResponse)? = { validate(it) },
    ): SemiontSession {
        val recording = Recording()
        val test = currentCoroutineContext()
        val scheduler = checkNotNull(test[TestCoroutineScheduler]) { "a session world's session is made under runTest" }
        val client = SemiontClient(recording, recording, recording, context = test.minusKey(Job), clock = scheduler.timeSource)
        val session = SemiontSession(TARGET, client, token, held, renew, asking, { told += it }, Random(0))
        val said = session.errors()
        CoroutineScope(Dispatchers.Unconfined).launch { said.collect { if (it is SessionError) errors += it } }
        return session
    }

    suspend fun isKept(): Boolean = kept.held() != null

    fun said(): List<Pair<String, String?>> = errors.map { it.code to it.message }
}
