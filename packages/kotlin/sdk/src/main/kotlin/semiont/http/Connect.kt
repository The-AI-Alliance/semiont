@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.http

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import semiont.SemiontClient
import semiont.bus.Operations
import semiont.bus.replyChannelsFor
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode
import semiont.errors.IdentityUnverifiableError
import semiont.errors.IdentityUnverifiableReason
import semiont.errors.SemiontError
import semiont.identifiers.UserId
import semiont.identity.kbDid
import semiont.telemetry.futureOf
import semiont.types.HttpEndpoint
import semiont.types.KbDescription
import java.net.http.HttpClient
import java.util.concurrent.CompletableFuture
import kotlin.coroutines.CoroutineContext
import kotlin.random.Random
import kotlin.time.TimeSource

/** Who the knowledge base at an address says it is: its did, and how it describes itself. */
public data class ConnectionIdentity @JvmExposeBoxed constructor(@get:JvmExposeBoxed public val did: UserId, public val description: KbDescription)

/**
 * Ask the knowledge base at `target` what it is, with a token just issued. It
 * describes itself only to a caller that is signed in, so this is asked after
 * the sign-in, and never assumed from the address a person typed or the row
 * they clicked. The knowledge base is asked with `http`, by a client that runs
 * on the caller's context, measures its deadline by `clock`, and draws its
 * emit retry's jitter from `random`. Throws `IdentityUnverifiableError`:
 * `unreachable` when the knowledge base was not reached, `not-reported` when
 * it answered that it cannot say what it is.
 */
public suspend fun describeConnection(
    target: HttpEndpoint,
    access: String,
    http: HttpClient = ownHttp,
    clock: TimeSource = TimeSource.Monotonic,
    random: Random = Random.Default,
): ConnectionIdentity {
    val baseUrl = try {
        gatewayUrl(target)
    } catch (invalid: IllegalArgumentException) {
        throw IdentityUnverifiableError(IdentityUnverifiableReason.Unreachable, invalid.message ?: "Invalid KB hostname")
    }
    // A client of this one operation: it hears its replies and nothing else.
    val context = currentCoroutineContext().minusKey(Job)
    val transport = HttpTransport(baseUrl, MutableStateFlow(access), replyChannelsFor(Operations.BROWSE_KB_REQUESTED), http = http, context = context, clock = clock, random = random)
    val description = try {
        SemiontClient(transport, HttpContentTransport(transport), transport, context = context, clock = clock).use { asking -> asking.browse.kb() }
    } catch (refusal: BusRequestError) {
        // A refusal is the knowledge base answering that it cannot say what it is.
        val why = if (refusal.reason == BusRequestErrorCode.Rejected) IdentityUnverifiableReason.NotReported else IdentityUnverifiableReason.Unreachable
        throw IdentityUnverifiableError(why, refusal.message)
    } catch (unanswered: SemiontError) {
        // Anything else is not having reached it.
        throw IdentityUnverifiableError(IdentityUnverifiableReason.Unreachable, unanswered.message)
    } finally {
        transport.close()
    }
    val did = try {
        kbDid(description.domain)
    } catch (invalid: IllegalArgumentException) {
        // A domain no did can hold says nothing of who this is.
        throw IdentityUnverifiableError(IdentityUnverifiableReason.NotReported, invalid.message ?: "no did can hold ${description.domain}")
    }
    return ConnectionIdentity(did, description)
}

/** `describeConnection`, for Java, on `context`. */
@JvmOverloads
public fun describeConnectionFuture(
    target: HttpEndpoint,
    access: String,
    http: HttpClient = ownHttp,
    context: CoroutineContext = Dispatchers.Default,
    clock: TimeSource = TimeSource.Monotonic,
    random: Random = Random.Default,
): CompletableFuture<ConnectionIdentity> = CoroutineScope(context).futureOf { describeConnection(target, access, http, clock, random) }
