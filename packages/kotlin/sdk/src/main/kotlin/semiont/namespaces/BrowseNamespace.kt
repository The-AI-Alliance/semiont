@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.namespaces

import semiont.bus.Operations
import semiont.channels.Channels
import semiont.identifiers.AnnotationId
import semiont.identifiers.ResourceId
import semiont.transport.Content
import semiont.transport.ContentStream
import semiont.transport.ContentTransport
import semiont.types.AnchoredTextAnswer
import semiont.types.AttributedEvent
import semiont.types.BrowseAnnotationHistoryRequest
import semiont.types.BrowseClickEvent
import semiont.types.BrowseDirectoryRequest
import semiont.types.BrowseDirectoryRequestSort
import semiont.types.BrowseDirectoryResultResponse
import semiont.types.BrowseEventsRequest
import semiont.types.BrowseKbRequest
import semiont.types.BrowseResourceOpenEvent
import semiont.types.BrowseResourceViewedEvent
import semiont.types.GetAnnotationHistoryResponse
import semiont.types.GetResourceResponse
import semiont.types.KbDescription
import java.util.concurrent.CompletableFuture

/** Reads: one-shot reads, and this viewer's own signals. */
public class BrowseNamespace internal constructor(private val links: Links, private val content: ContentTransport) {
    /** A resource's description as linked data: itself, its annotations and the references to it. */
    public suspend fun resourceGraph(resourceId: ResourceId): GetResourceResponse = content.getResourceGraph(resourceId)

    /** `resourceGraph`, for Java. */
    @JvmExposeBoxed
    public fun resourceGraphFuture(resourceId: ResourceId): CompletableFuture<GetResourceResponse> = links.future { resourceGraph(resourceId) }

    /** A resource's anchored text: the text of its content with where each run is on a page, a stored decline, or why there is none. */
    public suspend fun resourceAnchoredText(resourceId: ResourceId): AnchoredTextAnswer = content.getAnchoredText(resourceId)

    /** `resourceAnchoredText`, for Java. */
    @JvmExposeBoxed
    public fun resourceAnchoredTextFuture(resourceId: ResourceId): CompletableFuture<AnchoredTextAnswer> = links.future { resourceAnchoredText(resourceId) }

    /** A resource's bytes, unchanged, with their media type. */
    public suspend fun resourceRepresentation(resourceId: ResourceId): Content = content.getBinary(resourceId)

    /** `resourceRepresentation`, for Java. */
    @JvmExposeBoxed
    public fun resourceRepresentationFuture(resourceId: ResourceId): CompletableFuture<Content> = links.future { resourceRepresentation(resourceId) }

    /** The same, as they arrive. */
    public suspend fun resourceRepresentationStream(resourceId: ResourceId): ContentStream = content.getBinaryStream(resourceId)

    /** `resourceRepresentationStream`, for Java. */
    @JvmExposeBoxed
    public fun resourceRepresentationStreamFuture(resourceId: ResourceId): CompletableFuture<ContentStream> = links.future { resourceRepresentationStream(resourceId) }

    /** A resource's events, each with who it is attributed to, asked for now. */
    public suspend fun resourceEvents(resourceId: ResourceId): List<AttributedEvent> =
        links.request(Operations.BROWSE_EVENTS_REQUESTED, BrowseEventsRequest(resourceId = resourceId)).response.events

    /** `resourceEvents`, for Java. */
    @JvmExposeBoxed
    public fun resourceEventsFuture(resourceId: ResourceId): CompletableFuture<List<AttributedEvent>> = links.future { resourceEvents(resourceId) }

    /** The events of one annotation. */
    public suspend fun annotationHistory(resourceId: ResourceId, annotationId: AnnotationId): GetAnnotationHistoryResponse =
        links.request(Operations.BROWSE_ANNOTATION_HISTORY_REQUESTED, BrowseAnnotationHistoryRequest(resourceId = resourceId, annotationId = annotationId)).response

    /** `annotationHistory`, for Java. */
    @JvmExposeBoxed
    public fun annotationHistoryFuture(resourceId: ResourceId, annotationId: AnnotationId): CompletableFuture<GetAnnotationHistoryResponse> =
        links.future { annotationHistory(resourceId, annotationId) }

    /** The entries of a directory of the knowledge base's tree: its root when no path is stated, by name when no order is. */
    public suspend fun files(path: String = ".", sort: BrowseDirectoryRequestSort = BrowseDirectoryRequestSort.Name): BrowseDirectoryResultResponse =
        links.request(Operations.BROWSE_DIRECTORY_REQUESTED, BrowseDirectoryRequest(path = path, sort = sort)).response

    /** `files`, for Java. */
    public fun filesFuture(path: String, sort: BrowseDirectoryRequestSort): CompletableFuture<BrowseDirectoryResultResponse> = links.future { files(path, sort) }

    /** What the knowledge base says of itself: its name and domain, and its working tree's branch. Asked every time: a branch changes with no event to say so. */
    public suspend fun kb(): KbDescription = links.request(Operations.BROWSE_KB_REQUESTED, BrowseKbRequest).response

    /** `kb`, for Java. */
    public fun kbFuture(): CompletableFuture<KbDescription> = links.future { kb() }

    /** Signal: open an annotation for this viewer. */
    @JvmExposeBoxed
    public fun click(annotationId: AnnotationId): Unit = links.signal(Channels.BROWSE_CLICK, BrowseClickEvent(annotationId = annotationId))

    /** Signal: open a resource for this viewer. */
    @JvmExposeBoxed
    public fun openResource(resourceId: ResourceId): Unit = links.signal(Channels.BROWSE_RESOURCE_OPEN, BrowseResourceOpenEvent(resourceId = resourceId))

    /** Report that this viewer is looking at a resource. It goes over the wire, and nobody awaits it. */
    @JvmExposeBoxed
    public fun resourceViewed(resourceId: ResourceId): Unit = links.report(Channels.BROWSE_RESOURCE_VIEWED, BrowseResourceViewedEvent(resourceId = resourceId))
}
