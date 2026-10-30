@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package semiont.testing

import kotlinx.coroutines.async
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import semiont.bus.OPERATIONS
import semiont.bus.Operations
import semiont.bus.request
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.identifiers.ResourceId
import semiont.transport.ConnectionState
import semiont.transport.Content
import semiont.transport.Frame
import semiont.transport.PutBinaryRequest
import semiont.types.wireJson
import kotlin.time.Duration.Companion.seconds

private fun obj(vararg pairs: Pair<String, JsonElement>): JsonObject = JsonObject(mapOf(*pairs))

private fun text(value: String): JsonPrimitive = JsonPrimitive(value)

private val RESOURCE = ResourceId("res-1")

/** A transport whose replies arrive on the test's clock. */
private fun TestScope.faulty(schedule: List<FaultAction> = emptyList(), respond: Respond = REFUSE_UNSCRIPTED, channels: Collection<String>? = null): FaultyTransport =
    FaultyTransport(schedule, respond, channels, StandardTestDispatcher(testScheduler))

/** A request of the kb's description, as a client asks it. */
private suspend fun asked(transport: FaultyTransport, timeoutMs: Long = 1_000): JsonObject =
    request(transport, Operations.BROWSE_KB_REQUESTED, obj(), timeoutMs)

/** What a consumer's tests are built on, held to what they say of themselves. */
class DoublesTest {
    @Test
    fun aRequestIsAnsweredWithWhatWasQueuedForItsOperationOneEachInOrder() = runTest(timeout = 10.seconds) {
        val transport = faulty()
        transport.queueReply("browse:kb-requested", listOf(obj("name" to text("first")), obj("name" to text("second"))))
        assertEquals(obj("response" to obj("name" to text("first"))), asked(transport))
        assertEquals(obj("response" to obj("name" to text("second"))), asked(transport))
        transport.close()
    }

    @Test
    fun aRequestNothingWasScriptedForIsRefusedByNameAndIsStillOnRecord() = runTest(timeout = 10.seconds) {
        val transport = faulty()
        val refused = assertThrows<TransportError> { asked(transport) }
        assertTrue(refused.message!!.contains("\"browse:kb-requested\""), refused.message)
        assertEquals(listOf("browse:kb-requested"), transport.requestLog.map { it.channel })
        transport.close()
    }

    @Test
    fun whatNoQueuedResponseAnswersTheTransportsOwnGatewayDoes() = runTest(timeout = 10.seconds) {
        val transport = faulty(respond = { operation, _ -> obj("asked" to text(operation)) })
        transport.queueReply("browse:kb-requested", listOf(null))
        assertEquals(obj(), asked(transport), "a queued reply that carries none")
        assertEquals(obj("response" to obj("asked" to text("browse:kb-requested"))), asked(transport))
        transport.close()
    }

    @Test
    fun eachRequestInTurnMeetsTheNextActionOfTheScheduleAndTheScheduleComesRoundAgain() = runTest(timeout = 10.seconds) {
        val transport = faulty(schedule = listOf(Deliver, DropReply, Delay(50), RejectEmit), respond = { _, _ -> obj() })
        asked(transport)
        assertEquals(BusRequestErrorCode.Timeout, assertThrows<BusRequestError> { asked(transport, timeoutMs = 100) }.reason)
        val delayed = async { asked(transport) }
        advanceTimeBy(49)
        runCurrent()
        assertFalse(delayed.isCompleted)
        advanceTimeBy(2)
        runCurrent()
        assertTrue(delayed.isCompleted)
        assertThrows<TransportError> { asked(transport) }
        asked(transport)
        assertEquals(listOf(Deliver, DropReply, Delay(50), RejectEmit, Deliver), transport.requestLog.map { it.action })
        transport.close()
    }

    @Test
    fun aDuplicatedReplyIsDeliveredTwice() = runTest(timeout = 10.seconds) {
        val transport = faulty(schedule = listOf(DuplicateReply), respond = { _, _ -> obj() })
        val replies = mutableListOf<Frame>()
        launch { transport.frames("browse:kb-result").collect { replies += it } }
        runCurrent()
        asked(transport)
        runCurrent()
        assertEquals(2, replies.size)
        transport.close()
    }

    @Test
    fun aRequestTheGatewayRefusesIsAnsweredOnItsFailureChannelBeforeAnythingQueued() = runTest(timeout = 10.seconds) {
        val transport = faulty()
        transport.queueReply("browse:kb-requested", listOf(obj()))
        transport.refuseWhen { _, _ -> obj("code" to text("not-found"), "message" to text("no such kb")) }
        val refused = assertThrows<BusRequestError> { asked(transport) }
        assertEquals(BusRequestErrorCode.NotFound to "no such kb", refused.reason to refused.message)
        transport.close()
    }

    @Test
    fun aReplyThatNamesWhatItAnswersForNamesWhatItsRequestNamed() = runTest(timeout = 10.seconds) {
        val operation = OPERATIONS.values.first { it.replyNames.isNotEmpty() }
        val transport = faulty(respond = { _, _ -> obj() })
        val sent = JsonObject(operation.replyNames.associateWith { text("ref-1") } + ("other" to text("x")))
        val answered = request(transport, operation, sent, 1_000)
        assertEquals(JsonObject(operation.replyNames.associateWith { text("ref-1") } + ("response" to obj())), answered)
        transport.close()
    }

    @Test
    fun whatIsOnlySentIsDeliveredToWhoeverListensAndIntoAClientsBus() = runTest(timeout = 10.seconds) {
        val transport = faulty()
        val heard = mutableListOf<Frame>()
        launch { transport.frames("beckon:sparkle").collect { heard += it } }
        runCurrent()
        transport.emit("beckon:sparkle", obj("annotationId" to text("ann-1")), null, null)
        runCurrent()
        assertEquals(listOf("beckon:sparkle"), heard.map { it.channel })
        assertEquals(emptyList<RequestLogEntry>(), transport.requestLog, "what is only sent is no request")
        assertEquals(listOf("beckon:sparkle"), transport.emitted.map { it.channel })
        transport.close()
    }

    @Test
    fun theLogHoldsEachRequestAsItWasSentAndARequestMadeAgainUnderOneKey() {
        assertEquals(retryKeyOf("job:claim", obj("b" to text("2"), "a" to text("1"))), retryKeyOf("job:claim", obj("a" to text("1"), "_userId" to text("u"), "b" to text("2"))))
        assertFalse(retryKeyOf("job:claim", obj("a" to text("1"))) == retryKeyOf("job:claim", obj("a" to text("2"))))
    }

    @Test
    fun aTestSaysWhatTheWireDoesItsStateItsFailuresAndWhatItCarries() = runTest(timeout = 10.seconds) {
        val transport = faulty()
        val states = mutableListOf<ConnectionState>()
        launch { transport.state.collect { states += it } }
        val failures = mutableListOf<String>()
        launch { transport.failures().collect { failures += it.message!! } }
        runCurrent()
        transport.setState(ConnectionState.Reconnecting)
        transport.fail(TransportError(TransportErrorCode.Unavailable, "the gateway is down"))
        runCurrent()
        assertEquals(listOf(ConnectionState.Open, ConnectionState.Reconnecting), states)
        assertEquals(listOf("the gateway is down"), failures)
        transport.close()
    }

    @Test
    fun theHoldsOnEachResourcesScopeAreCounted() = runTest(timeout = 10.seconds) {
        val transport = faulty()
        val one = transport.subscribeToResource(RESOURCE)
        val other = transport.subscribeToResource(RESOURCE)
        assertEquals(2 to listOf(RESOURCE), transport.holds(RESOURCE) to transport.scopes)
        one.close()
        other.close()
        assertEquals(0 to emptyList<ResourceId>(), transport.holds(RESOURCE) to transport.scopes)
        transport.close()
    }

    @Test
    fun aTransportToldItsChannelsDeliversNoOther() = runTest(timeout = 10.seconds) {
        val transport = faulty(channels = listOf("beckon:sparkle"))
        assertTrue(transport.isSubscribed("beckon:sparkle"))
        assertFalse(transport.isSubscribed("beckon:focus"))
        assertEquals(BusRequestErrorCode.Unsubscribed, assertThrows<BusRequestError> { transport.frames("beckon:focus") }.reason)
        transport.close()
    }

    @Test
    fun aClosedTransportHasEndedEverythingAndDoesNothingMore() = runTest(timeout = 10.seconds) {
        val transport = faulty()
        val states = async { transport.state.toList() }
        runCurrent()
        transport.close()
        runCurrent()
        assertEquals(ConnectionState.Closed, states.await().last())
        assertNull(transport.emit("beckon:sparkle", obj(), null, null))
        assertEquals(emptyList<Frame>(), transport.emitted)
    }

    @Test
    fun contentInMemoryKeepsWhatItIsGivenGivesItBackAndRefusesWhatNobodyStored() = runTest(timeout = 10.seconds) {
        val content = InMemoryContent()
        val upload = content.putBinary(PutBinaryRequest(name = "a.txt", file = "the words".toByteArray(), format = "text/plain", storageUri = "file://a.txt"))
        val made = upload.await().resourceId
        assertEquals("test-content-1", made.value)
        assertEquals(listOf(9L), upload.progress.toList().map { it.bytesUploaded })
        assertEquals("the words", String(content.getBinary(made).bytes))
        content.seed(RESOURCE, Content("text/plain", "seeded".toByteArray()))
        assertEquals("seeded", String(content.getBinaryStream(RESOURCE).bytes.toList().single()))
        val missing = assertThrows<TransportError> { content.getAnnotations(ResourceId("res-9")) }
        assertEquals(TransportErrorCode.NotFound, missing.reason)
        assertEquals(listOf(PutBinary::class, GetBinary::class, GetBinaryStream::class, GetAnnotations::class), content.calls.map { it::class })
    }

    @Test
    fun aStubGatewayAnswersOnlyWhatItWasToldToAndRecordsEveryCall() = runTest(timeout = 10.seconds) {
        val gateway = StubGateway()
        val refused = assertThrows<TransportError> { gateway.getMediaToken(RESOURCE) }
        assertTrue(refused.message!!.contains("getMediaToken"), refused.message)
        val health = wireJson.decodeFromJsonElement(semiont.types.HealthResponse.serializer(), obj("status" to text("ok"), "message" to text("all well"), "timestamp" to text("2026-01-01T00:00:00.000Z"), "version" to text("1")))
        gateway.health(health)
        assertSame(health, gateway.healthCheck())
        assertEquals(listOf("getMediaToken res-1", "healthCheck"), gateway.calls)
    }

    @Test
    fun aTestClientIsARealClientOverTheDoublesItIsGivenOrMakes() = runTest(timeout = 10.seconds) {
        val transport = faulty()
        val content = InMemoryContent()
        val gateway = StubGateway()
        val made = TestClient(transport, content, gateway, semiont.ClientTiming(), null, StandardTestDispatcher(testScheduler), testScheduler.timeSource)
        assertSame(transport, made.client.transport)
        assertSame(transport, made.transport)
        assertSame(content, made.content)
        assertSame(gateway, made.gateway)
        // A request of the client goes over the transport the test scripted.
        transport.queueReply("browse:kb-requested", listOf(obj("name" to text("A KB"))))
        assertEquals(obj("response" to obj("name" to text("A KB"))), request(made.client.transport, Operations.BROWSE_KB_REQUESTED, obj(), 1_000))
        made.client.close()
        transport.close()
        // Given nothing, it makes doubles that answer nothing.
        val bare = TestClient()
        assertTrue(bare.transport.requestLog.isEmpty() && bare.content.calls.isEmpty() && bare.gateway.calls.isEmpty())
        bare.client.close()
        bare.transport.close()
    }
}
