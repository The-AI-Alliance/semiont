@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.errors

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import semiont.identifiers.JobId
import semiont.types.CommandErrorCode
import semiont.types.FailureClass

/** A failure of the SDK's, under a code of protocol/specs/src/errors/codes.json. */
public sealed class SemiontError(
    /** What failed, as it is said. */
    override val message: String,
) : Exception(message) {
    /** The code, as every SDK spells it. */
    public abstract val code: String

    /** How long the failure said to wait before trying again, when it said so. */
    public open val retryAfterMs: Long? get() = null
}

/** What a transport failed: a request a server refused, or one none answered. */
public class TransportError(
    /** Why, as a code of the transport's vocabulary. */
    public val reason: TransportErrorCode,
    message: String,
    /** The HTTP status a server answered, when one did. */
    public val status: Int? = null,
    override val retryAfterMs: Long? = null,
) : SemiontError(message) {
    override val code: String get() = reason.code

    internal companion object {
        /** A server's refusal, under the code its status fails with. */
        fun ofStatus(message: String, status: Int, retryAfterMs: Long?): TransportError =
            TransportError(transportErrorCodeFor(status), message, status, retryAfterMs)

        /** A request nobody answered. */
        fun withoutResponse(message: String): TransportError = TransportError(TransportErrorCode.Unavailable, message)
    }
}

/** Why a bus request did not resolve. */
public class BusRequestError(
    /** Why, as a code of the bus request's vocabulary. */
    public val reason: BusRequestErrorCode,
    message: String,
    /** The payload of the failure frame the request was answered with, as its channel's reader reads it, when it was answered with one. */
    public val failure: JsonObject? = null,
) : SemiontError(message) {
    override val code: String get() = reason.code

    internal companion object {
        /**
         * The failure an operation's failure channel answered with, as the
         * table read it, in its words `said`: under the client code its own
         * code becomes, or, when it states none, the code of a failure that
         * states none (codes.json's `unrecognizedFailure`).
         */
        fun answered(said: String, payload: JsonObject): BusRequestError {
            val reason = when (val stated = codeOf(payload["code"])) {
                null -> UNRECOGNIZED_FAILURE
                else -> busRequestCodeOf(stated)
            }
            return BusRequestError(reason, said, payload)
        }

        /**
         * The code a failure the table read states, as CommandError's closed
         * code: none when it states none, or null. The table leaves out a
         * code it does not recognize, so one that `CommandErrorCode` does not
         * name is the table and the type disagreeing.
         */
        private fun codeOf(held: JsonElement?): CommandErrorCode? {
            if (held == null || held == JsonNull) return null
            return CommandErrorCode.entries.singleOrNull { held is JsonPrimitive && held.isString && it.value == held.content }
                ?: error("the table read the code $held, which CommandErrorCode does not name")
        }
    }
}

/**
 * A sign-in at the issuer a knowledge base trusts, or a renewal there, that
 * did not succeed. One that carries a status is the issuer's answer; one that
 * carries none got no answer: a refusal and an outage are different events.
 */
public class SignInError(
    /** Why, as a code of the sign-in vocabulary. */
    public val reason: SignInErrorCode,
    message: String,
    /** The HTTP status the issuer answered, when it answered. */
    public val status: Int? = null,
) : SemiontError(message) {
    override val code: String get() = reason.code
}

/** A failure that makes a session itself unusable. A request's own failure stays with its caller. */
public class SessionError(
    /** Why, as a code of the session vocabulary. */
    public val reason: SessionErrorCode,
    message: String,
    /** The knowledge base whose session it is. */
    public val kbId: String,
) : SemiontError(message) {
    override val code: String get() = reason.code
}

/** A followed job that ended without its result: it failed, was cancelled, or stalled. */
public class JobError @JvmExposeBoxed constructor(
    /** Why, as a code of the job vocabulary. */
    public val reason: JobErrorCode,
    message: String,
    /** The job, when its creation was answered. */
    @get:JvmExposeBoxed
    public val jobId: JobId?,
    /** What kind of failure its worker said it was, when it said: a provider that would not answer, or a job that broke. */
    public val failureClass: FailureClass?,
) : SemiontError(message) {
    override val code: String get() = reason.code
}

/**
 * A knowledge base whose identity a sign-in could not learn: it was not
 * reached, or it answered that it cannot say what it is. Either way nothing
 * is registered, and the sign-in stops there.
 */
public class IdentityUnverifiableError(
    /** Why, as a code of the knowledge base identity vocabulary. */
    public val reason: IdentityUnverifiableReason,
    message: String,
) : SemiontError(message) {
    override val code: String get() = reason.code
}

/** A span no annotation was built of: it is not the text's, or, for a PDF, is nowhere on its pages. */
public class SpanRefusedError(
    /** Which refusal it is, as a code of the span-refusal vocabulary. */
    public val reason: SpanRefusal,
    message: String,
) : SemiontError(message) {
    override val code: String get() = reason.code
}
