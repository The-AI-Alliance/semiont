package semiont.errors

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** A failure of the SDK's, under a code of specs/src/errors/codes.json. */
public sealed class SemiontError(message: String) : Exception(message) {
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
) : SemiontError(message) {
    override val code: String get() = reason.code

    internal companion object {
        /** The failure an operation's failure channel answered with: under the client code its own code becomes. */
        fun answered(payload: JsonObject): BusRequestError {
            val wire = (payload["code"] as? JsonPrimitive)?.contentOrNull
            val said = (payload["message"] as? JsonPrimitive)?.contentOrNull ?: "the request failed"
            return BusRequestError(BUS_REQUEST_CODE_BY_WIRE_CODE[wire] ?: UNRECOGNIZED_FAILURE, said)
        }
    }
}
