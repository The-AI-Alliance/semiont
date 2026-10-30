package semiont

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import semiont.errors.SemiontError
import semiont.identifiers.ResourceId
import semiont.transport.Broadcast
import semiont.transport.ConnectionState
import semiont.transport.Content
import semiont.transport.ContentStream
import semiont.transport.ContentTransport
import semiont.transport.Events
import semiont.transport.Frame
import semiont.transport.FrameSink
import semiont.transport.GatewayOperations
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
import semiont.types.HealthResponse
import semiont.types.MediaTokenResponse
import semiont.types.ProtectedResourceMetadata
import semiont.types.StatusResponse
import semiont.types.UserResponse
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList

/** What a call did: on which route, to what, with what. */
internal data class Did(val route: String, val name: String, val sends: JsonObject)

internal fun obj(vararg pairs: Pair<String, JsonElement>) = JsonObject(mapOf(*pairs))

/**
 * A transport, a content transport and a gateway in one, which keep what each
 * call did and answer none: a case holds what a call did first, not what it
 * was answered.
 */
internal class Recording : Transport, GatewayOperations, ContentTransport {
    val did = CopyOnWriteArrayList<Did>()
    val any = CompletableDeferred<Unit>()
    private val router = ReplyRouter()

    private fun saw(route: String, name: String, sends: JsonObject) {
        did += Did(route, name, sends)
        any.complete(Unit)
    }

    override val baseUrl: String = "http://kb.test"
    override val state: Watched<ConnectionState> = Watched(MutableStateFlow(ConnectionState.Open)) { it == ConnectionState.Closed }

    override suspend fun emit(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): Long? {
        saw("emit", channel, payload)
        return 1
    }

    override fun emitFuture(channel: String, payload: JsonObject, scope: ResourceId?, correlationId: String?): CompletableFuture<Long?> =
        throw UnsupportedOperationException("the client emits by its own future")

    override fun frames(channel: String): Events<Frame> = Broadcast<Frame>().listen()

    override fun isSubscribed(channel: String): Boolean = true

    override fun subscribeToResource(resourceId: ResourceId): ResourceHold = ResourceHold {}

    override fun failures(): Events<SemiontError> = Broadcast<SemiontError>().listen()

    override fun bridgeInto(bus: FrameSink) = Unit

    override fun trackReply(correlationId: String, replyChannels: Collection<String>): PendingReply = router.track(correlationId, replyChannels)

    override fun close() = router.close()

    private suspend fun <T> asked(route: String, name: String, sends: JsonObject = obj()): T {
        saw(route, name, sends)
        awaitCancellation()
    }

    private fun resource(resourceId: ResourceId) = obj("resourceId" to JsonPrimitive(resourceId.value))

    private fun unasked(): Nothing = throw UnsupportedOperationException("the client asks by its suspending call")

    override suspend fun getCurrentUser(): UserResponse = asked("gateway", "getCurrentUser")

    override fun getCurrentUserFuture(): CompletableFuture<UserResponse> = unasked()

    override suspend fun getMediaToken(resourceId: ResourceId): MediaTokenResponse = asked("gateway", "getMediaToken", resource(resourceId))

    override fun getMediaTokenFuture(resourceId: ResourceId): CompletableFuture<MediaTokenResponse> = unasked()

    override suspend fun getProtectedResourceMetadata(): ProtectedResourceMetadata = asked("gateway", "getProtectedResourceMetadata")

    override fun getProtectedResourceMetadataFuture(): CompletableFuture<ProtectedResourceMetadata> = unasked()

    override suspend fun healthCheck(): HealthResponse = asked("gateway", "healthCheck")

    override fun healthCheckFuture(): CompletableFuture<HealthResponse> = unasked()

    override suspend fun getStatus(): StatusResponse = asked("gateway", "getStatus")

    override fun getStatusFuture(): CompletableFuture<StatusResponse> = unasked()

    override fun putBinary(request: PutBinaryRequest): Upload {
        saw(
            "content",
            "putBinary",
            obj(
                "name" to JsonPrimitive(request.name),
                "content" to JsonPrimitive(request.file.toString(Charsets.UTF_8)),
                "format" to JsonPrimitive(request.format),
                "storageUri" to JsonPrimitive(request.storageUri),
            ),
        )
        return Upload(CompletableDeferred(), Events(emptyFlow()) {})
    }

    override suspend fun getBinary(resourceId: ResourceId): Content = asked("content", "getBinary", resource(resourceId))

    override fun getBinaryFuture(resourceId: ResourceId): CompletableFuture<Content> = unasked()

    override suspend fun getBinaryStream(resourceId: ResourceId): ContentStream = asked("content", "getBinaryStream", resource(resourceId))

    override fun getBinaryStreamFuture(resourceId: ResourceId): CompletableFuture<ContentStream> = unasked()

    override suspend fun getResourceGraph(resourceId: ResourceId): GetResourceResponse = asked("content", "getResourceGraph", resource(resourceId))

    override fun getResourceGraphFuture(resourceId: ResourceId): CompletableFuture<GetResourceResponse> = unasked()

    override suspend fun getAnnotations(resourceId: ResourceId): GetAnnotationsResponse = asked("content", "getAnnotations", resource(resourceId))

    override fun getAnnotationsFuture(resourceId: ResourceId): CompletableFuture<GetAnnotationsResponse> = unasked()

    override suspend fun getAnchoredText(resourceId: ResourceId): AnchoredTextAnswer = asked("content", "getAnchoredText", resource(resourceId))

    override fun getAnchoredTextFuture(resourceId: ResourceId): CompletableFuture<AnchoredTextAnswer> = unasked()
}
