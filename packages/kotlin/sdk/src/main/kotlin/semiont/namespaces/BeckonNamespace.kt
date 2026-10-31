@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.namespaces

import semiont.channels.Channels
import semiont.identifiers.AnnotationId
import semiont.identifiers.ResourceId
import semiont.types.BeckonFocusEvent
import semiont.types.BeckonHoverEvent
import semiont.types.BeckonSparkleEvent
import semiont.types.BrowseClickEvent
import semiont.types.BrowseResourceOpenEvent
import java.util.concurrent.CompletableFuture

/** Attention: driving the other participants' viewers, each drive answered by how many of them the gateway reached. */
public class BeckonNamespace internal constructor(private val links: Links) {
    /** Draw the others' attention to an annotation of a resource, or, with none, to the resource as a whole. */
    public suspend fun attention(resourceId: ResourceId, annotationId: AnnotationId? = null): Long? =
        links.drive(Channels.BECKON_FOCUS, BeckonFocusEvent(annotationId = annotationId, resourceId = resourceId))

    /** `attention`, for Java. */
    @JvmOverloads
    @JvmExposeBoxed
    public fun attentionFuture(resourceId: ResourceId, annotationId: AnnotationId? = null): CompletableFuture<Long?> = links.future { attention(resourceId, annotationId) }

    /** Open an annotation in the others' viewers. */
    public suspend fun click(annotationId: AnnotationId): Long? = links.drive(Channels.BROWSE_CLICK, BrowseClickEvent(annotationId = annotationId))

    /** `click`, for Java. */
    @JvmExposeBoxed
    public fun clickFuture(annotationId: AnnotationId): CompletableFuture<Long?> = links.future { click(annotationId) }

    /** Open a resource in the others' viewers. */
    public suspend fun openResource(resourceId: ResourceId): Long? = links.drive(Channels.BROWSE_RESOURCE_OPEN, BrowseResourceOpenEvent(resourceId = resourceId))

    /** `openResource`, for Java. */
    @JvmExposeBoxed
    public fun openResourceFuture(resourceId: ResourceId): CompletableFuture<Long?> = links.future { openResource(resourceId) }

    /** Make an annotation sparkle in the others' viewers. */
    public suspend fun sparkleAll(annotationId: AnnotationId): Long? = links.drive(Channels.BECKON_SPARKLE, BeckonSparkleEvent(annotationId = annotationId))

    /** `sparkleAll`, for Java. */
    @JvmExposeBoxed
    public fun sparkleAllFuture(annotationId: AnnotationId): CompletableFuture<Long?> = links.future { sparkleAll(annotationId) }

    /** Signal: an annotation is hovered in this viewer, or none is. */
    @JvmExposeBoxed
    public fun hover(annotationId: AnnotationId?): Unit = links.signal(Channels.BECKON_HOVER, BeckonHoverEvent(annotationId = annotationId))

    /** Signal: an annotation sparkles in this viewer. */
    @JvmExposeBoxed
    public fun sparkle(annotationId: AnnotationId): Unit = links.signal(Channels.BECKON_SPARKLE, BeckonSparkleEvent(annotationId = annotationId))
}
