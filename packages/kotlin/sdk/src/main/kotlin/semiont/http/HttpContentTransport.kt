@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.http

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.consumeAsFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.future.future
import kotlinx.coroutines.jdk9.asFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import semiont.errors.TransportError
import semiont.identifiers.ResourceId
import semiont.transport.Content
import semiont.transport.ContentStream
import semiont.transport.ContentTransport
import semiont.transport.Events
import semiont.transport.PutBinaryRequest
import semiont.transport.Upload
import semiont.transport.UploadProgress
import semiont.types.AnchoredTextAnswer
import semiont.types.CreateResourceResponse
import semiont.types.GetAnnotationsResponse
import semiont.types.GetResourceResponse
import semiont.types.ResourceUpload
import java.io.IOException
import java.net.http.HttpRequest
import java.nio.ByteBuffer
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Flow

/** The pieces an upload's body is sent in. */
private const val PIECE_BYTES = 64 * 1024

/** Where a resource is read: its id is one segment of the path as it is, which the rule an id is held to keeps a segment. */
private fun pathOf(resourceId: ResourceId): String = "/resources/${resourceId.value}"

/** `text` as a part's header states it: what would end the value, or the line, written as `%XX`. */
private fun quoted(text: String): String = text.replace("\"", "%22").replace("\r", "%0D").replace("\n", "%0A")

/** An upload's `multipart/form-data` body: each field under its own name, in the order the spec's form states them, and the bytes as the part `file`. */
private class Form(request: PutBinaryRequest) {
    val boundary = "semiont-${UUID.randomUUID().toString().replace("-", "")}"
    private val parts: List<ByteArray>
    val size: Long

    init {
        val values = mapOf(
            "name" to request.name,
            "format" to request.format,
            "storageUri" to request.storageUri,
            "language" to request.language?.takeIf { it.isNotEmpty() },
            "entityTypes" to request.entityTypes.takeIf { it.isNotEmpty() }?.let { names -> JsonArray(names.map(::JsonPrimitive)).toString() },
            "sourceAnnotationId" to request.sourceAnnotationId?.value,
            "sourceResourceId" to request.sourceResourceId?.value,
            "generationPrompt" to request.generationPrompt?.takeIf { it.isNotEmpty() },
            "jobId" to request.jobId?.value,
            "isDraft" to request.isDraft?.toString(),
        )
        val before = StringBuilder()
        val after = StringBuilder()
        val form = ResourceUpload.serializer().descriptor
        for (index in 0 until form.elementsCount) {
            val field = form.getElementName(index)
            if (field == "file") continue
            val value = values[field] ?: continue
            val part = "--$boundary\r\nContent-Disposition: form-data; name=\"${quoted(field)}\"\r\n\r\n$value\r\n"
            // The fields that come before the bytes, so whatever reads the form knows what the bytes are before it meets them.
            if (field in setOf("name", "format", "storageUri")) before.append(part) else after.append(part)
        }
        before.append("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"${quoted(request.name)}\"\r\nContent-Type: ${request.format}\r\n\r\n")
        parts = listOf(before.toString().toByteArray(), request.file, "\r\n$after--$boundary--\r\n".toByteArray())
        size = parts.sumOf { it.size.toLong() }
    }

    /** The body, a piece at a time, each counted as it is taken to be sent. A body sent again starts again from its first piece. */
    fun publisher(sent: (Long) -> Unit): HttpRequest.BodyPublisher {
        val pieces = parts.flatMap { part -> (part.indices step PIECE_BYTES).map { ByteBuffer.wrap(part, it, minOf(PIECE_BYTES, part.size - it)) } }
        val source = Flow.Publisher<ByteBuffer> { subscriber ->
            subscriber.onSubscribe(object : Flow.Subscription {
                private var next = 0
                private var total = 0L
                private var done = false

                @Synchronized
                override fun request(n: Long) {
                    var left = n
                    while (left > 0 && next < pieces.size && !done) {
                        val piece = pieces[next++].duplicate()
                        total += piece.remaining()
                        subscriber.onNext(piece)
                        sent(total)
                        left--
                    }
                    if (next == pieces.size && !done) {
                        done = true
                        subscriber.onComplete()
                    }
                }

                @Synchronized
                override fun cancel() {
                    done = true
                }
            })
        }
        return HttpRequest.BodyPublishers.fromPublisher(source, size)
    }
}

/** Content over the gateway an `HttpTransport` speaks to. */
public class HttpContentTransport(private val transport: HttpTransport) : ContentTransport {
    private val exchange = transport.exchange
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun putBinary(request: PutBinaryRequest): Upload {
        val form = Form(request)
        val progress = Channel<UploadProgress>(Channel.UNLIMITED)
        var said = -1L
        val report = { sent: Long ->
            // Never less than it last said: a body sent again after a renewal counts from where it was.
            synchronized(progress) {
                if (sent > said) {
                    said = sent
                    progress.trySend(UploadProgress(sent, form.size))
                }
            }
        }
        val sending = scope.async(start = CoroutineStart.DEFAULT) {
            try {
                // No deadline: how long an upload takes is how large the resource is.
                exchange.answer(
                    CreateResourceResponse.serializer(),
                    "POST",
                    "/resources",
                    headers = mapOf("Content-Type" to "multipart/form-data; boundary=${form.boundary}"),
                    body = { form.publisher(report) },
                    atLength = true,
                )
            } finally {
                progress.close()
            }
        }
        return Upload(sending, Events(progress.consumeAsFlow()))
    }

    private suspend fun arriving(resourceId: ResourceId): Pair<String, Flow.Publisher<List<ByteBuffer>>> {
        val response = exchange.begin("GET", pathOf(resourceId))
        return response.headers().firstValue("content-type").orElse("application/octet-stream") to response.body()
    }

    override suspend fun getBinary(resourceId: ResourceId): Content {
        val (contentType, body) = arriving(resourceId)
        val bytes = try {
            readAll(body)
        } catch (error: IOException) {
            throw exchange.failed(TransportError.withoutResponse("GET ${pathOf(resourceId)} ended before its bytes did: ${error.message}"))
        }
        return Content(contentType, bytes)
    }

    @JvmExposeBoxed
    override fun getBinaryFuture(resourceId: ResourceId): CompletableFuture<Content> = scope.future { getBinary(resourceId) }

    override suspend fun getBinaryStream(resourceId: ResourceId): ContentStream {
        val (contentType, body) = arriving(resourceId)
        val pieces = flow {
            try {
                body.asFlow().collect { buffers ->
                    for (buffer in buffers) {
                        val bytes = ByteArray(buffer.remaining())
                        buffer.get(bytes)
                        emit(bytes)
                    }
                }
            } catch (error: IOException) {
                throw exchange.failed(TransportError.withoutResponse("GET ${pathOf(resourceId)} ended before its bytes did: ${error.message}"))
            }
        }
        return ContentStream(contentType, pieces, scope)
    }

    @JvmExposeBoxed
    override fun getBinaryStreamFuture(resourceId: ResourceId): CompletableFuture<ContentStream> = scope.future { getBinaryStream(resourceId) }

    override suspend fun getResourceGraph(resourceId: ResourceId): GetResourceResponse =
        exchange.answer(GetResourceResponse.serializer(), "GET", "${pathOf(resourceId)}/jsonld")

    @JvmExposeBoxed
    override fun getResourceGraphFuture(resourceId: ResourceId): CompletableFuture<GetResourceResponse> = scope.future { getResourceGraph(resourceId) }

    override suspend fun getAnnotations(resourceId: ResourceId): GetAnnotationsResponse =
        exchange.answer(GetAnnotationsResponse.serializer(), "GET", "${pathOf(resourceId)}/annotations")

    @JvmExposeBoxed
    override fun getAnnotationsFuture(resourceId: ResourceId): CompletableFuture<GetAnnotationsResponse> = scope.future { getAnnotations(resourceId) }

    override suspend fun getAnchoredText(resourceId: ResourceId): AnchoredTextAnswer =
        exchange.answer(AnchoredTextAnswer.serializer(), "GET", "${pathOf(resourceId)}/anchored-text")

    @JvmExposeBoxed
    override fun getAnchoredTextFuture(resourceId: ResourceId): CompletableFuture<AnchoredTextAnswer> = scope.future { getAnchoredText(resourceId) }

    override fun close(): Unit = scope.cancel()
}
