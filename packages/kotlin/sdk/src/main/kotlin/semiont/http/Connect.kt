package semiont.http

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
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
import java.util.concurrent.CompletableFuture

/** Who the knowledge base at an address says it is: its did, and how it describes itself. */
public data class ConnectionIdentity(public val did: UserId, public val description: KbDescription)

/**
 * Ask the knowledge base at `target` what it is, with a token just issued. It
 * describes itself only to a caller that is signed in, so this is asked after
 * the sign-in, and never assumed from the address a person typed or the row
 * they clicked. Throws `IdentityUnverifiableError`: `unreachable` when the
 * knowledge base was not reached, `not-reported` when it answered that it
 * cannot say what it is.
 */
public suspend fun describeConnection(target: HttpEndpoint, access: String): ConnectionIdentity {
    val baseUrl = try {
        gatewayUrl(target)
    } catch (invalid: IllegalArgumentException) {
        throw IdentityUnverifiableError(IdentityUnverifiableReason.Unreachable, invalid.message ?: "Invalid KB hostname")
    }
    // A client of this one operation: it hears its replies and nothing else.
    val transport = HttpTransport(baseUrl, MutableStateFlow(access), replyChannelsFor(Operations.BROWSE_KB_REQUESTED))
    val description = try {
        SemiontClient(transport, HttpContentTransport(transport), transport).use { asking -> asking.browse.kb() }
    } catch (refusal: BusRequestError) {
        // A refusal is the knowledge base answering that it cannot say what it is.
        val why = if (refusal.reason == BusRequestErrorCode.Rejected) IdentityUnverifiableReason.NotReported else IdentityUnverifiableReason.Unreachable
        throw IdentityUnverifiableError(why, refusal.message ?: refusal.code)
    } catch (unanswered: SemiontError) {
        // Anything else is not having reached it.
        throw IdentityUnverifiableError(IdentityUnverifiableReason.Unreachable, unanswered.message ?: unanswered.code)
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

/** `describeConnection`, for Java. */
public fun describeConnectionFuture(target: HttpEndpoint, access: String): CompletableFuture<ConnectionIdentity> =
    CoroutineScope(Dispatchers.Default).futureOf { describeConnection(target, access) }
