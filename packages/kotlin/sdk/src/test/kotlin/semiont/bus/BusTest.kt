package semiont.bus

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import semiont.channels.CHANNEL_NAMES
import semiont.channels.Channel
import semiont.channels.Channels
import semiont.channels.Empty
import semiont.channels.ScopedChannel
import semiont.channels.TRACE_FIELD
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode
import semiont.errors.SemiontError
import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.identifiers.ResourceId
import semiont.identifiers.UserId
import semiont.transport.Broadcast
import semiont.transport.Carried
import semiont.transport.ConnectionState
import semiont.transport.Delivered
import semiont.transport.Events
import semiont.transport.Frame
import semiont.transport.FrameRefusal
import semiont.transport.FrameRefusalReason
import semiont.transport.FrameSink
import semiont.transport.Heard
import semiont.transport.PendingReply
import semiont.transport.ReplyRouter
import semiont.transport.ResourceHold
import semiont.transport.TraceContext
import semiont.transport.Transport
import semiont.transport.Watched
import semiont.types.AnchoredTextAnswer
import semiont.types.BrowseProfilesRequest
import semiont.types.BusPingMessage
import semiont.types.FrameAddEntityTypeCommand
import semiont.types.GatherAnnotationOptions
import semiont.types.JobCompleteCommand
import java.util.concurrent.CompletableFuture

private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

private val ALICE = "did:web:kb.example:users:alice"
private val ONE = ResourceId.parse("res-one")!!
private val TWO = ResourceId.parse("res-two")!!

/** What an emit was given. */
private data class Emitted(val channel: String, val payload: JsonObject, val scope: ResourceId?, val correlationId: String?)

/** A transport that delivers what a test gives it, and answers an emit as the test says. */
private class Wire(private val subscribed: Set<String>) : Transport {
    override val baseUrl: String = "http://kb.test"
    private val now = MutableStateFlow(ConnectionState.Open)
    override val state: Watched<ConnectionState> = Watched(now) { it == ConnectionState.Closed }
    val emitted = mutableListOf<Emitted>()
    var answer: (Emitted) -> Unit = {}
    private val channels = mutableMapOf<String, Broadcast<Carried>>()
    private val router = ReplyRouter(Dispatchers.Unconfined)
    val holds = mutableMapOf<ResourceId, Int>()

    override suspend fun emit(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): Long? {
        val sent = Emitted(channel, payload, scope, correlationId)
        emitted += sent
        answer(sent)
        return 1
    }

    override fun emitFuture(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): CompletableFuture<Long?> =
        throw UnsupportedOperationException("the bus emits by its own future")

    override fun frames(channel: String): Events<Carried> = synchronized(channels) { channels.getOrPut(channel) { Broadcast() } }.listen()

    fun deliver(carried: Carried) {
        synchronized(channels) { channels[carried.channel] }?.deliver(carried)
        router.route(carried)
    }

    override fun isSubscribed(channel: String): Boolean = channel in subscribed

    override fun subscribeToResource(resourceId: ResourceId): ResourceHold {
        synchronized(holds) { holds[resourceId] = (holds[resourceId] ?: 0) + 1 }
        return ResourceHold { synchronized(holds) { holds[resourceId] = holds.getValue(resourceId) - 1 } }
    }

    override fun failures(): Events<SemiontError> = Broadcast<SemiontError>().listen()

    override fun bridgeInto(bus: FrameSink): Unit = throw UnsupportedOperationException("nothing here bridges")

    override fun trackReply(correlationId: String, replyChannels: Collection<String>): PendingReply = router.track(correlationId, replyChannels)

    override fun close() {
        now.value = ConnectionState.Closed
        router.close()
    }
}

private val ADD = Operations.FRAME_ADD_ENTITY_TYPE

private fun added(tag: String): FrameAddEntityTypeCommand = decoded(Channels.FRAME_ADD_ENTITY_TYPE, json("""{"tag":"$tag"}"""))

/** This as the frame it is; a test that reads a refusal here fails. */
private fun <P> Heard<P>.delivered(): Delivered<P> = when (this) {
    is Delivered -> this
    is FrameRefusal -> throw AssertionError("refused: $this")
}

class BusTest {
    @Test
    fun anEmitSendsThePayloadAsTheWireCarriesIt() = runBlocking {
        val wire = Wire(emptySet())
        val reached = Bus(wire).emit(Channels.FRAME_ADD_ENTITY_TYPE, added("Person"), scope = ONE, correlationId = "c-1")
        assertEquals(1L, reached)
        assertEquals(listOf(Emitted("frame:add-entity-type", json("""{"tag":"Person"}"""), ONE, "c-1")), wire.emitted)
    }

    @Test
    fun aFrameIsGivenDecodedWithWhoEmittedItAndItsTrace() = runBlocking {
        val wire = Wire(emptySet())
        val frames = Bus(wire).frames(Channels.FRAME_ADD_ENTITY_TYPE)
        val trace = TraceContext("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")
        wire.deliver(Frame("frame:add-entity-type", json("""{"tag":"Person","_userId":"$ALICE","$TRACE_FIELD":{"traceparent":"${trace.traceparent}"}}"""), "c-1", null, trace))
        val delivered = withTimeout(5_000) { frames.first() }.delivered()
        assertEquals("delivered", delivered.status)
        assertEquals("Person", delivered.payload.tag)
        // A stamp its payload declares is the payload's own, and kept.
        assertEquals(UserId.parse(ALICE), delivered.payload.userId)
        assertEquals(UserId.parse(ALICE), delivered.userId)
        assertEquals("c-1", delivered.correlationId)
        assertEquals(trace, delivered.trace)
        assertNull(delivered.scope)
    }

    @Test
    fun aStampItsPayloadDoesNotDeclareIsLeftOutBeforeItIsRead() = runBlocking {
        val wire = Wire(emptySet())
        val frames = Bus(wire).frames(Channels.PANEL_CLOSE)
        wire.deliver(Frame("panel:close", json("""{"_userId":"$ALICE","$TRACE_FIELD":{"traceparent":"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"}}""")))
        val delivered = withTimeout(5_000) { frames.first() }.delivered()
        assertEquals(Empty, delivered.payload)
        assertEquals(UserId.parse(ALICE), delivered.userId)
    }

    @Test
    fun aFrameThatIsNotTheChannelsIsToldTheReaderInItsPlaceAndTheNextFollows() = runBlocking {
        val wire = Wire(emptySet())
        val frames = Bus(wire).frames(Channels.FRAME_ADD_ENTITY_TYPE)
        val lacking = json("""{"_userId":"$ALICE"}""")
        val malformed = json("""{"tag":{"not":"a tag"}}""")
        wire.deliver(Frame("frame:add-entity-type", lacking))
        wire.deliver(Frame("frame:add-entity-type", malformed))
        wire.deliver(Frame("frame:add-entity-type", json("""{"tag":"Person"}""")))
        val (refused, unread, next) = withTimeout(5_000) { frames.take(3).toList() }
        // The way from the frame to its first fault, why, and the payload as it came.
        assertEquals(FrameRefusal("frame:add-entity-type", "payload.tag", FrameRefusalReason.Lacks, lacking, null, null), refused)
        assertEquals("refused", refused.status)
        // One that holds a member of a kind its schema does not allow is malformed there.
        assertEquals(FrameRefusal("frame:add-entity-type", "payload.tag", FrameRefusalReason.Malformed, malformed, null, null), unread)
        assertEquals("Person", next.delivered().payload.tag)
    }

    @Test
    fun aFrameTheTransportRefusedIsToldTheReaderOfItsChannelAndScopeAsItCame() = runBlocking {
        val wire = Wire(emptySet())
        val frames = Bus(wire).frames(Channels.JOB_STARTED, ONE)
        fun refused(resource: ResourceId) = FrameRefusal("job:started", "correlationId", FrameRefusalReason.Malformed, json("{}"), null, resource)
        wire.deliver(refused(TWO))
        wire.deliver(refused(ONE))
        assertEquals(refused(ONE), withTimeout(5_000) { frames.first() })
    }

    @Test
    fun everyChannelsPayloadAndEveryUnionIsHeldToTheTableByItsSchemasName() {
        val payloads = Channels::class.java.fields.mapNotNull { field ->
            when (val channel = field.get(Channels)) {
                is Channel<*> -> channel.payload
                is ScopedChannel<*> -> channel.payload
                else -> null
            }
        }
        assertEquals(CHANNEL_NAMES.size, payloads.size)
        // What is held to the table is found there: a type the table does not name is refused.
        for (payload in payloads) faultOf(payload.descriptor, json("{}"))
        assertEquals(Fault("", FrameRefusalReason.Malformed), faultOf(AnchoredTextAnswer.serializer().descriptor, Json.parseToJsonElement("[]")))
        assertEquals(Fault("resourceId", FrameRefusalReason.Lacks), faultOf(JobCompleteCommand.serializer().descriptor, json("""{"jobType":"mark"}""")))
    }

    @Test
    fun aValueIsHeldToItsValuesItsFormItsSizeAndTheMembersAClosedObjectNames() {
        fun malformed(member: String) = Fault(member, FrameRefusalReason.Malformed)
        val ping = BusPingMessage.serializer().descriptor
        val profiles = BrowseProfilesRequest.serializer().descriptor
        val options = GatherAnnotationOptions.serializer().descriptor
        for ((descriptor, text, fault) in listOf(
            Triple(ping, """{"event":"ping","data":""}""", null),
            Triple(ping, """{"event":"pong","data":""}""", malformed("event")),
            Triple(ping, """{"event":"ping","data":"x"}""", malformed("data")),
            Triple(profiles, """{"dids":["did:web:example.org"]}""", null),
            Triple(profiles, """{"dids":["did:\ud83d\ude00"]}""", null),
            Triple(profiles, """{"dids":[]}""", malformed("dids")),
            Triple(profiles, """{"dids":["web:example.org"]}""", malformed("dids")),
            Triple(profiles, """{"dids":["did:web:a b"]}""", malformed("dids")),
            Triple(options, """{"contextWindow":100.0}""", null),
            Triple(options, """{"contextWindow":5000}""", null),
            Triple(options, """{"contextWindow":99}""", malformed("contextWindow")),
            Triple(options, """{"contextWindow":5001}""", malformed("contextWindow")),
            // A closed object: what it describes first, then the first member it does not name, by code point.
            Triple(profiles, """{"dids":["did:web:example.org"],"more":1}""", malformed("more")),
            Triple(profiles, """{"dids":[],"more":1}""", malformed("dids")),
            Triple(profiles, """{"more":1}""", Fault("dids", FrameRefusalReason.Lacks)),
            Triple(profiles, """{"dids":["did:web:example.org"],"\ud83d\ude00":1,"\uff61":1}""", malformed("\uff61")),
        )) {
            assertEquals(fault, faultOf(descriptor, Json.parseToJsonElement(text)), text)
        }
    }

    @Test
    fun aFrameThatLacksAMemberDeepInsideItIsRefusedByTheWayToIt() = runBlocking {
        val wire = Wire(emptySet())
        val frames = Bus(wire).frames(Channels.JOB_STARTED, ONE)
        val unsequenced = json(
            """{"id":"e-1","type":"job:started","timestamp":"2026-10-29T00:00:00Z","userId":"$ALICE","resourceId":"${ONE.value}","version":1,"payload":{},"metadata":{}}""",
        )
        wire.deliver(Frame("job:started", unsequenced, null, ONE))
        assertEquals(FrameRefusal("job:started", "payload.metadata.sequenceNumber", FrameRefusalReason.Lacks, unsequenced, null, ONE), withTimeout(5_000) { frames.first() })
    }

    @Test
    fun aScopedChannelIsReadForOneResourceAndHoldsItsScopeWhileItIsRead() = runBlocking {
        val wire = Wire(emptySet())
        val frames = Bus(wire).frames(Channels.JOB_STARTED, ONE)
        assertEquals(1, wire.holds[ONE])
        fun stored(resource: ResourceId) = json(
            """{"id":"e-1","type":"job:started","timestamp":"2026-10-29T00:00:00Z","userId":"$ALICE","resourceId":"${resource.value}","version":1,"payload":{},"metadata":{"sequenceNumber":1}}""",
        )
        wire.deliver(Frame("job:started", stored(TWO), null, TWO))
        wire.deliver(Frame("job:started", stored(ONE), null, ONE))
        val delivered = withTimeout(5_000) { frames.first() }.delivered()
        assertEquals(ONE, delivered.scope)
        assertEquals("job:started", delivered.payload.type)
        // Its reading is over, and with it the hold.
        assertEquals(0, wire.holds[ONE])
    }

    @Test
    fun closingAReadEndsItAndLetsGoOfItsScope() = runBlocking {
        val wire = Wire(emptySet())
        val frames = Bus(wire).frames(Channels.JOB_STARTED, ONE)
        frames.close()
        assertEquals(0, wire.holds[ONE])
        assertEquals(emptyList<Heard<*>>(), withTimeout(5_000) { frames.toList() })
    }

    @Test
    fun aTypedRequestGivesItsOperationsResult() = runBlocking {
        val wire = Wire(replyChannelsFor(ADD).toSet())
        wire.answer = { sent -> wire.deliver(Frame("frame:entity-type-add-ok", json("{}"), sent.correlationId)) }
        assertEquals(Empty, Bus(wire).request(ADD, added("Person"), timeoutMs = 5_000))
        assertEquals("frame:add-entity-type", wire.emitted.single().channel)
        assertEquals(json("""{"tag":"Person"}"""), wire.emitted.single().payload)
    }

    @Test
    fun aFailureReplyIsTheRequestsError() = runBlocking {
        val wire = Wire(replyChannelsFor(ADD).toSet())
        wire.answer = { sent -> wire.deliver(Frame("frame:entity-type-add-failed", json("""{"message":"no such thing"}"""), sent.correlationId)) }
        val error = assertThrows(BusRequestError::class.java) { runBlocking { Bus(wire).request(ADD, added("Person"), timeoutMs = 5_000) } }
        assertEquals("no such thing", error.message)
    }

    @Test
    fun aFailureWhoseCodeTheWireDoesNotListIsRejectedInItsOwnWords() = runBlocking {
        val wire = Wire(replyChannelsFor(ADD).toSet())
        wire.answer = { sent -> wire.deliver(Frame("frame:entity-type-add-failed", json("""{"message":"a code from a later peer","code":"not-a-code-yet"}"""), sent.correlationId)) }
        val error = assertThrows(BusRequestError::class.java) { runBlocking { Bus(wire).request(ADD, added("Person"), timeoutMs = 5_000) } }
        assertEquals(BusRequestErrorCode.Rejected, error.reason)
        assertEquals("a code from a later peer", error.message)
    }

    // A failure is held to its channel's schema as a result is: one with no
    // words, or with a code that is no text, is not its channel's, and is
    // refused naming its first fault. It is given no words.
    @Test
    fun aFailureThatIsNotItsChannelsIsRefusedNamingItsFault() = runBlocking {
        for ((failure, said) in listOf(
            "{}" to "it has no `message`",
            """{"code":"not-found"}""" to "it has no `message`",
            """{"message":"refused","code":7}""" to "its `code` is malformed",
        )) {
            val wire = Wire(replyChannelsFor(ADD).toSet())
            wire.answer = { sent -> wire.deliver(Frame("frame:entity-type-add-failed", json(failure), sent.correlationId)) }
            val error = assertThrows(TransportError::class.java) { runBlocking { Bus(wire).request(ADD, added("Person"), timeoutMs = 5_000) } }
            assertEquals(TransportErrorCode.Error, error.reason)
            assertEquals("a payload on frame:entity-type-add-failed is not that channel's: $said", error.message)
        }
    }

    @Test
    fun aResultThatIsNotTheOperationsIsATransportFailure() = runBlocking {
        val wire = Wire(replyChannelsFor(ADD).toSet())
        wire.answer = { sent -> wire.deliver(Frame("frame:entity-type-add-ok", json("""{"unasked":true,"_userId":"$ALICE"}"""), sent.correlationId)) }
        val error = assertThrows(TransportError::class.java) { runBlocking { Bus(wire).request(ADD, added("Person"), timeoutMs = 5_000) } }
        assertEquals(TransportErrorCode.Error, error.reason)
        // What it says names the channel, and none of what the payload held.
        assertTrue(error.message.contains("frame:entity-type-add-ok"), error.message)
        assertTrue(!error.message.contains("unasked") && !error.message.contains(ALICE), error.message)
    }

    @Test
    fun aReplyRefusedWithTheRequestsCorrelationIdFailsTheRequestAtOnce() = runBlocking {
        val wire = Wire(replyChannelsFor(ADD).toSet())
        wire.answer = { sent ->
            wire.deliver(FrameRefusal("frame:entity-type-add-ok", "addedByALaterGateway", FrameRefusalReason.Malformed, json("{}"), sent.correlationId, null))
        }
        // Long before the request's own timeout.
        val error = assertThrows(TransportError::class.java) {
            runBlocking { withTimeout(5_000) { Bus(wire).request(ADD, added("Person"), timeoutMs = 60_000) } }
        }
        assertEquals(TransportErrorCode.Error, error.reason)
        assertEquals("a frame on frame:entity-type-add-ok is not that channel's: its `addedByALaterGateway` is malformed", error.message)
    }

    @Test
    fun aRequestWhoseRepliesCannotArriveIsRefusedAndSendsNothing() = runBlocking {
        val wire = Wire(emptySet())
        val error = assertThrows(BusRequestError::class.java) { runBlocking { Bus(wire).request(ADD, added("Person"), timeoutMs = 5_000) } }
        assertEquals(BusRequestErrorCode.Unsubscribed, error.reason)
        assertTrue(wire.emitted.isEmpty())
    }

    @Test
    fun theFreeRequestGivesTheReplyAsItCame() = runBlocking {
        val wire = Wire(replyChannelsFor(ADD).toSet())
        wire.answer = { sent -> wire.deliver(Frame("frame:entity-type-add-ok", json("""{"_userId":"$ALICE"}"""), sent.correlationId)) }
        assertEquals(json("""{"_userId":"$ALICE"}"""), request(wire, OPERATIONS.getValue("frame:add-entity-type"), json("""{"tag":"Person"}"""), 5_000))
    }

    @Test
    fun replyChannelsForNamesEachChannelOnce() {
        assertEquals(listOf("frame:entity-type-add-ok", "frame:entity-type-add-failed"), replyChannelsFor(ADD, ADD))
    }
}
