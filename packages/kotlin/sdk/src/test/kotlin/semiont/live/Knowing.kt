package semiont.live

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertTrue
import semiont.ClientTiming
import semiont.Recording
import semiont.SemiontClient
import semiont.bus.OPERATIONS
import semiont.cache.CacheQuery
import semiont.cache.CacheRefreshTrigger
import semiont.cache.CacheRefreshWhen
import semiont.cache.CacheState
import semiont.cache.Cached
import semiont.errors.SemiontError
import semiont.identifiers.AnnotationId
import semiont.identifiers.ResourceId
import semiont.storage.CachePersistence
import semiont.transport.Broadcast
import semiont.transport.ConnectionState
import semiont.transport.Content
import semiont.transport.ContentStream
import semiont.transport.ContentTransport
import semiont.transport.Events
import semiont.transport.Frame
import semiont.transport.FrameSink
import semiont.transport.PendingReply
import semiont.transport.PutBinaryRequest
import semiont.transport.ReplyRouter
import semiont.transport.ResourceHold
import semiont.transport.Transport
import semiont.transport.Upload
import semiont.transport.Watched
import semiont.types.AnchoredTextAnswer
import semiont.types.GetAnnotationsResponse
import semiont.types.GetResourceResponse
import semiont.types.wireJson
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/*
 * A knowledge base's answers and events, as small as their shapes allow: what
 * a test of a client's live queries scripts.
 */

internal val RESOURCE = ResourceId("res-1")
internal val OTHER = ResourceId("res-2")

/** An annotation of `RESOURCE`, and one of `OTHER`. */
internal val ANNOTATION = AnnotationId("ann-1")
internal val ELSEWHERE = AnnotationId("ann-2")

internal val LIMITS = listOf("gather:limits-requested", "job:limits-requested", "match:limits-requested")

/** The operations each live query asks, or the read of the content transport it makes, as client/surface.json names that read. */
internal val ASKS: Map<CacheQuery, List<String>> = mapOf(
    CacheQuery.Resource to listOf("browse:resource-requested"),
    CacheQuery.Annotations to listOf("getAnnotations"),
    CacheQuery.Annotation to listOf("browse:annotation-requested"),
    CacheQuery.Events to listOf("browse:events-requested"),
    CacheQuery.ReferencedBy to listOf("gather:referenced-by-requested"),
    CacheQuery.Resources to listOf("browse:resources-requested"),
    CacheQuery.MatchedResources to listOf("match:resources-requested"),
    CacheQuery.EntityTypes to listOf("browse:entity-types-requested"),
    CacheQuery.TagSchemas to listOf("browse:tag-schemas-requested"),
    CacheQuery.Engines to listOf("browse:engines-requested") + LIMITS,
)

internal fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

internal fun descriptor(resource: ResourceId, name: String = "A resource"): JsonObject =
    json("""{"@context":"https://schema.org","@id":"${resource.value}","name":"$name","representations":[]}""")

internal fun annotation(annotationId: AnnotationId, resource: ResourceId, modified: String? = null): JsonObject = JsonObject(
    json(
        """{"@context":"http://www.w3.org/ns/anno.jsonld","type":"Annotation","id":"${annotationId.value}","motivation":"highlighting","target":"${resource.value}","created":"2026-10-06T00:00:00.000Z"}""",
    ) + listOfNotNull(modified?.let { "modified" to JsonPrimitive(it) }),
)

private val PAGE = json("""{"resources":[],"total":0,"offset":0,"limit":100}""")

private val ANSWERS: Map<String, JsonElement> = mapOf(
    "browse:resource-requested" to JsonObject(mapOf("resource" to descriptor(RESOURCE), "lastSequence" to JsonPrimitive(1))),
    "browse:annotation-requested" to JsonObject(mapOf("annotation" to annotation(ANNOTATION, RESOURCE), "resource" to JsonNull, "resolvedResource" to JsonNull)),
    "browse:events-requested" to json("""{"events":[],"total":0,"resourceId":"${RESOURCE.value}"}"""),
    "gather:referenced-by-requested" to json("""{"referencedBy":[]}"""),
    "browse:resources-requested" to PAGE,
    "match:resources-requested" to JsonObject(PAGE + ("matchKind" to JsonPrimitive("lexical"))),
    "browse:entity-types-requested" to json("""{"entityTypes":["Person"]}"""),
    "browse:tag-schemas-requested" to json("""{"tagSchemas":[]}"""),
    "browse:engines-requested" to json("""{"engines":[]}"""),
) + LIMITS.associateWith { json("""{"limits":[]}""") }

/**
 * A gateway's transport as a test of live queries meets it. It answers each
 * operation a live query asks with a small knowledge base's answer, as often
 * as it is asked, or, `answered` false, answers none: the test does. It
 * delivers what a test gives it, keeps each hold on a resource's scope, and
 * goes down and up as a test says.
 */
internal class Kb(private val answered: Boolean = true) : Transport {
    val emitted = CopyOnWriteArrayList<Frame>()
    private val router = ReplyRouter()
    private var sink: FrameSink? = null
    private val now = MutableStateFlow(ConnectionState.Open)
    private val holds = ConcurrentHashMap<ResourceId, Int>()
    private val queued = ConcurrentHashMap<String, ArrayDeque<JsonElement>>()
    private val refused = ConcurrentHashMap.newKeySet<String>()

    /** Answer the next requests of `operation` with these responses, one each, before what the knowledge base would. */
    fun queue(operation: String, vararg responses: JsonElement) {
        synchronized(queued) { queued.getOrPut(operation) { ArrayDeque() }.addAll(responses) }
    }

    /** Refuse every request of `operation` from now on. */
    fun refuse(operation: String) {
        refused += operation
    }

    /** Every request of `operation`, in the order they were made. */
    fun askedFor(operation: String): List<Frame> = emitted.filter { it.channel == operation }

    /** How many hold the scope of `resource`. */
    fun holds(resource: ResourceId): Int = holds[resource] ?: 0

    /** The resources whose scope something holds. */
    fun scopes(): List<ResourceId> = holds.filterValues { it > 0 }.keys.sortedBy { it.value }

    fun setState(state: ConnectionState) {
        now.value = state
    }

    /** Deliver a frame as the bus would: to the client, published to everyone there whatever scope it came on, as a transport bridges it, and to the request it answers. */
    fun deliver(frame: Frame) {
        sink?.deliver(frame.copy(scope = null))
        router.route(frame)
    }

    /** Answer a request with `response`, as the service that answers its operation would: naming what the request named. */
    fun answer(request: Frame, response: JsonElement) {
        val operation = OPERATIONS.getValue(request.channel)
        val named = operation.replyNames.associateWith { request.payload.getValue(it) }
        deliver(Frame(operation.result.name, JsonObject(named + ("response" to response)), request.correlationId))
    }

    /** Answer a request with a failure. */
    fun refuse(request: Frame, message: String = "the service refused") {
        deliver(Frame(OPERATIONS.getValue(request.channel).failure.name, json("""{"code":"rejected","message":"$message"}"""), request.correlationId))
    }

    override val baseUrl: String = "http://kb.test"
    override val state: Watched<ConnectionState> = Watched(now) { it == ConnectionState.Closed }

    override suspend fun emit(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): Long? {
        val request = Frame(channel, payload, correlationId, scope)
        emitted += request
        if (!answered || correlationId == null) return 1
        when {
            channel in refused -> refuse(request, "the scripted gateway refuses $channel")
            else -> {
                val response = synchronized(queued) { queued[channel]?.removeFirstOrNull() } ?: ANSWERS[channel]
                if (response != null) answer(request, response) else refuse(request, "nothing scripted answers $channel")
            }
        }
        return 1
    }

    override fun emitFuture(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): CompletableFuture<Long?> =
        throw UnsupportedOperationException("the client emits by its own future")

    override fun frames(channel: String): Events<Frame> = Broadcast<Frame>().listen()

    override fun isSubscribed(channel: String): Boolean = true

    override fun subscribeToResource(resourceId: ResourceId): ResourceHold {
        holds.merge(resourceId, 1, Int::plus)
        return ResourceHold { holds.merge(resourceId, -1, Int::plus) }
    }

    override fun failures(): Events<SemiontError> = Broadcast<SemiontError>().listen()

    override fun bridgeInto(bus: FrameSink) {
        sink = bus
    }

    override fun trackReply(correlationId: String, replyChannels: Collection<String>): PendingReply = router.track(correlationId, replyChannels)

    override fun close() {
        now.value = ConnectionState.Closed
        router.close()
    }
}

/** A content transport whose only read a live query makes, a resource's annotations, is answered with `RESOURCE`'s one annotation, or, `answered` false, never. */
internal class KbContent(private val answered: Boolean = true) : ContentTransport {
    val reads = CopyOnWriteArrayList<ResourceId>()

    override suspend fun getAnnotations(resourceId: ResourceId): GetAnnotationsResponse {
        reads += resourceId
        if (!answered) awaitCancellation()
        return wireJson.decodeFromJsonElement(
            GetAnnotationsResponse.serializer(),
            JsonObject(mapOf("annotations" to kotlinx.serialization.json.JsonArray(listOf(annotation(ANNOTATION, RESOURCE))), "total" to JsonPrimitive(1))),
        )
    }

    private fun unasked(): Nothing = throw AssertionError("a live query makes no other read")

    override fun putBinary(request: PutBinaryRequest): Upload = unasked()

    override suspend fun getBinary(resourceId: ResourceId): Content = unasked()

    override fun getBinaryFuture(resourceId: ResourceId): CompletableFuture<Content> = unasked()

    override suspend fun getBinaryStream(resourceId: ResourceId): ContentStream = unasked()

    override fun getBinaryStreamFuture(resourceId: ResourceId): CompletableFuture<ContentStream> = unasked()

    override suspend fun getResourceGraph(resourceId: ResourceId): GetResourceResponse = unasked()

    override fun getResourceGraphFuture(resourceId: ResourceId): CompletableFuture<GetResourceResponse> = unasked()

    override fun getAnnotationsFuture(resourceId: ResourceId): CompletableFuture<GetAnnotationsResponse> = unasked()

    override suspend fun getAnchoredText(resourceId: ResourceId): AnchoredTextAnswer = unasked()

    override fun getAnchoredTextFuture(resourceId: ResourceId): CompletableFuture<AnchoredTextAnswer> = unasked()

    override fun close() = Unit
}

/** A client over a knowledge base that answers every read a live query makes, or none, keeping its queries where `persistence` says. */
internal class KbWorld(windowMs: Long = 100, answered: Boolean = true, persistence: CachePersistence? = null) {
    val kb = Kb(answered)
    val content = KbContent(answered)
    val client = SemiontClient(kb, content, Recording(), ClientTiming(invalidationWindowMs = windowMs), persistence)
    private val watching = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** How often each operation is asked, and the annotations read, so far. */
    fun asked(): Map<String, Int> = (kb.emitted.map { it.channel } + content.reads.map { "getAnnotations" }).groupingBy { it }.eachCount()

    /** A collector of `query`, from now on. */
    fun <T : Any> watch(query: Cached<T>): Watcher<T> = Watcher(query, watching)

    fun close() {
        client.close()
        watching.cancel()
    }
}

/** One collector of a live query: the states it is given, in order, and its end. */
internal class Watcher<T : Any>(query: Cached<T>, scope: CoroutineScope) {
    private val given = Channel<CacheState<T>>(Channel.UNLIMITED)
    val ended = CompletableDeferred<Unit>()
    private val collecting: Job = scope.launch {
        try {
            query.collect { given.send(it) }
        } finally {
            ended.complete(Unit)
        }
    }

    /** The next state it is given, which is to come soon. */
    suspend fun next(): CacheState<T> = withTimeout(5_000) { given.receive() }

    /** The next state it is given that is a value. */
    suspend fun ready(): CacheState.Ready<T> {
        while (true) (next() as? CacheState.Ready<T>)?.let { return it }
    }

    /** It is given nothing for `ms`. */
    suspend fun nothingFor(ms: Long = 200) {
        val given = withTimeoutOrNull(ms) { this@Watcher.given.receive() }
        assertTrue(given == null, "it was given $given")
    }

    /** Its states end soon, with nothing more given. */
    suspend fun ends() {
        withTimeout(5_000) { ended.await() }
        assertTrue(given.tryReceive().getOrNull() == null, "it was given something before it ended")
    }

    /** It stops collecting. */
    fun leave(): Unit = collecting.cancel()
}

/** Wait until `done`, as soon as it is so. */
internal suspend fun eventually(done: () -> Boolean) = withTimeout(5_000) {
    while (!done()) delay(5)
}

/** A recorded event, as the stream carries it. */
internal fun recorded(kind: String, resource: ResourceId?, payload: JsonObject = JsonObject(emptyMap())): JsonObject = JsonObject(
    json("""{"id":"evt-1","type":"$kind","timestamp":"2026-10-06T00:00:00.000Z","userId":"did:web:example.org:users:alice","version":1,"metadata":{"sequenceNumber":1}}""") +
        ("payload" to payload) + listOfNotNull(resource?.let { "resourceId" to JsonPrimitive(it.value) }),
)

/** An event that is `trigger`, about `resource` and its annotation `of`. The stream carries one on its resource's scope. */
internal fun event(trigger: CacheRefreshTrigger, whenIs: CacheRefreshWhen? = null, resource: ResourceId = RESOURCE, of: AnnotationId = ANNOTATION): Frame {
    val name = trigger.wire
    val named = json("""{"annotationId":"${of.value}"}""")
    return when (trigger) {
        CacheRefreshTrigger.Reopened -> throw AssertionError("a reopening is no event")
        CacheRefreshTrigger.BusResumeGap -> Frame(name, json("""{"scope":"${resource.value}","lastSeenId":"p-1","reason":"retention-exceeded"}"""))
        CacheRefreshTrigger.MarkDeleteOk -> Frame(name, json("""{"response":{"annotationId":"${of.value}"}}"""), "cid-delete")
        CacheRefreshTrigger.MarkRemoved -> Frame(name, recorded(name, resource, named), null, resource)
        CacheRefreshTrigger.MarkBodyUpdated -> {
            val updated = recorded(name, resource, named)
            val carried = if (whenIs == CacheRefreshWhen.Enriched) JsonObject(updated + ("annotation" to annotation(of, resource, "2026-10-06T01:00:00.000Z"))) else updated
            Frame(name, carried, null, resource)
        }
        CacheRefreshTrigger.MarkAdded, CacheRefreshTrigger.MarkEntityTagAdded, CacheRefreshTrigger.MarkEntityTagRemoved,
        CacheRefreshTrigger.MarkArchived, CacheRefreshTrigger.MarkUnarchived,
        -> Frame(name, recorded(name, resource), null, resource)
        // Heard by every client, on no scope.
        CacheRefreshTrigger.YieldCreated, CacheRefreshTrigger.YieldUpdated, CacheRefreshTrigger.YieldCloned, CacheRefreshTrigger.YieldMoved ->
            Frame(name, recorded(name, resource))
        CacheRefreshTrigger.FrameEntityTypeAdded, CacheRefreshTrigger.FrameTagSchemaAdded -> Frame(name, recorded(name, null))
    }
}
