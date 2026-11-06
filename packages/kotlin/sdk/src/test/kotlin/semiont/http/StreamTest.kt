package semiont.http

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.frame

private val QUICK = Timing(reconnectMs = 10, lazyRemoveMs = 10, lingerMs = 10)

/** The stream against a stand-in gateway: what it does with a line that is not a frame. */
class StreamTest {
    @Test
    fun aLineThatNamesNoChannelIsToldToTheFailureReportAndTheStreamGoesOn() = runBlocking {
        StreamGateway().use { gateway ->
            HttpTransport(gateway.origin, MutableStateFlow("t"), listOf("beckon:focus"), QUICK).use { transport ->
                val heard = transport.frames("beckon:focus")
                val told = transport.failures()
                withTimeout(5_000) { while (gateway.subscriptions.isEmpty()) delay(5) }

                gateway.send("e-1", """{"channel": "beckon:focus", "payload": {""")
                gateway.send("e-2", """{"payload": {"resourceId": "res-1"}}""")
                gateway.send("e-3", """{"channel": 7, "payload": {"resourceId": "res-1"}}""")
                gateway.send("e-4", """{"channel": "beckon:focus", "payload": {"annotationId": "after"}}""")

                val read = withTimeout(5_000) { heard.firstOf(1) }
                assertEquals(listOf(JsonPrimitive("after")), read.map { it.frame().payload.getValue("annotationId") })
                val failures = withTimeout(5_000) { told.firstOf(3) }
                assertEquals(
                    listOf("it is malformed", "it has no `channel`", "its `channel` is malformed").map {
                        Triple(TransportErrorCode.Error, null, "the stream carried what is not a frame: $it")
                    },
                    failures.map { Triple((it as TransportError).reason, it.status, it.message) },
                )
                assertEquals(1, gateway.subscriptions.size, "the stream goes on")
            }
        }
    }
}
