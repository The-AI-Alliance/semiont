@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.namespaces

import semiont.bus.Operations
import semiont.channels.Channels
import semiont.identifiers.AnnotationId
import semiont.identifiers.ResourceId
import semiont.types.AnnotationSelector
import semiont.types.CreateAnnotationRequest
import semiont.types.MarkArchiveCommand
import semiont.types.MarkCreateOkResponse
import semiont.types.MarkCreateRequest
import semiont.types.MarkDeleteCommand
import semiont.types.MarkRequestedEvent
import semiont.types.MarkSubmitEvent
import semiont.types.MarkUnarchiveCommand
import semiont.types.MarkUpdateEntityTypesCommand
import semiont.types.Motivation
import semiont.types.ResourceErrorEvent
import java.util.concurrent.CompletableFuture

/** Annotations, a resource's own metadata, and the annotating of a resource delegated as a job. */
public class MarkNamespace internal constructor(private val links: Links) {
    /** Create an annotation on the resource its target names: the annotation as the knowledge base made it. */
    public suspend fun annotation(request: CreateAnnotationRequest): MarkCreateOkResponse =
        links.request(Operations.MARK_CREATE_REQUEST, MarkCreateRequest(resourceId = request.target.source, request = request)).response

    /** `annotation`, for Java. */
    public fun annotationFuture(request: CreateAnnotationRequest): CompletableFuture<MarkCreateOkResponse> = links.future { annotation(request) }

    /** Delete an annotation of a resource. */
    public suspend fun delete(resourceId: ResourceId, annotationId: AnnotationId) {
        links.request(Operations.MARK_DELETE, MarkDeleteCommand(annotationId = annotationId, resourceId = resourceId))
    }

    /** `delete`, for Java. */
    @JvmExposeBoxed
    public fun deleteFuture(resourceId: ResourceId, annotationId: AnnotationId): CompletableFuture<Unit> = links.future { delete(resourceId, annotationId) }

    /** Archive a resource. */
    public suspend fun archive(resourceId: ResourceId) {
        links.request(Operations.MARK_ARCHIVE, MarkArchiveCommand(resourceId = resourceId))
    }

    /** `archive`, for Java. */
    @JvmExposeBoxed
    public fun archiveFuture(resourceId: ResourceId): CompletableFuture<Unit> = links.future { archive(resourceId) }

    /** Bring an archived resource back. */
    public suspend fun unarchive(resourceId: ResourceId) {
        links.request(Operations.MARK_UNARCHIVE, MarkUnarchiveCommand(resourceId = resourceId))
    }

    /** `unarchive`, for Java. */
    @JvmExposeBoxed
    public fun unarchiveFuture(resourceId: ResourceId): CompletableFuture<Unit> = links.future { unarchive(resourceId) }

    /** Change a resource's entity types from `current` to `updated`. */
    public suspend fun updateEntityTypes(resourceId: ResourceId, current: List<String>, updated: List<String>) {
        links.request(
            Operations.MARK_UPDATE_ENTITY_TYPES,
            MarkUpdateEntityTypesCommand(resourceId = resourceId, currentEntityTypes = current, updatedEntityTypes = updated),
        )
    }

    /** `updateEntityTypes`, for Java. */
    @JvmExposeBoxed
    public fun updateEntityTypesFuture(resourceId: ResourceId, current: List<String>, updated: List<String>): CompletableFuture<Unit> =
        links.future { updateEntityTypes(resourceId, current, updated) }

    /** Signal: an annotation of a span is asked for in this viewer. */
    @JvmExposeBoxed
    public fun request(source: ResourceId, selector: AnnotationSelector, motivation: Motivation): Unit =
        links.signal(Channels.MARK_REQUESTED, MarkRequestedEvent(source = source, selector = selector, motivation = motivation))

    /** Signal: an annotation is submitted in this viewer. */
    public fun submit(event: MarkSubmitEvent): Unit = links.signal(Channels.MARK_SUBMIT, event)

    /** Signal: a deletion failed, for this viewer to say. */
    public fun reportDeleteError(event: ResourceErrorEvent): Unit = links.signal(Channels.MARK_DELETE_ERROR, event)
}
