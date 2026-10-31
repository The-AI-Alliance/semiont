@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.namespaces

import semiont.Running
import semiont.bus.Operations
import semiont.cache.Cached
import semiont.cache.Keyed
import semiont.identifiers.AnnotationId
import semiont.identifiers.ResourceId
import semiont.types.GatherAnnotationComplete
import semiont.types.GatherAnnotationOptions
import semiont.types.GatherAnnotationRequest
import semiont.types.GatherResourceRequest
import semiont.types.GatherResourceRequestOptions
import semiont.types.GatheredContext
import semiont.types.GetReferencedByResponseReferencedByItem
import java.util.concurrent.CompletableFuture

/** How many characters of an annotation's source its context takes when none is stated. */
internal const val CONTEXT_WINDOW: Long = 2000

/** How many links out from a resource its context reaches when none is stated. */
internal const val RESOURCE_DEPTH: Long = 2

/** How many resources a resource's context takes when none is stated. */
internal const val RESOURCE_LIMIT: Long = 10

/** Whether a resource's context takes its resources' content when that is not stated. */
internal const val INCLUDES_CONTENT: Boolean = true

/** Whether a resource's context takes a summary when that is not stated. */
internal const val INCLUDES_SUMMARY: Boolean = false

/** Assembling the context a model is given, and what refers to a resource. */
public class GatherNamespace internal constructor(private val links: Links, private val live: Live) {
    /**
     * The context around one annotation, taking `contextWindow` characters of
     * its source: two thousand when none is stated. The source's context and
     * the target's are each included or left out as stated, and as the
     * gatherer decides when not.
     */
    @JvmOverloads
    @JvmExposeBoxed
    public fun annotation(
        resourceId: ResourceId,
        annotationId: AnnotationId,
        contextWindow: Long = CONTEXT_WINDOW,
        includeSourceContext: Boolean? = null,
        includeTargetContext: Boolean? = null,
    ): Running<GatherAnnotationComplete> {
        val options = GatherAnnotationOptions(contextWindow = contextWindow, includeSourceContext = includeSourceContext, includeTargetContext = includeTargetContext)
        val request = GatherAnnotationRequest(annotationId = annotationId, resourceId = resourceId, options = options)
        return Running(links.scope) { links.request(Operations.GATHER_REQUESTED, request) }
    }

    /**
     * The context around a whole resource. With nothing stated: two hops of the
     * graph, ten resources, their content, and no summary. `depth` is how many
     * links out from the resource the graph reaches, 1 to 3, nearest first. An
     * empty exclusion excludes nothing, and is not sent.
     */
    public suspend fun resource(
        resourceId: ResourceId,
        depth: Long = RESOURCE_DEPTH,
        maxResources: Long = RESOURCE_LIMIT,
        includeContent: Boolean = INCLUDES_CONTENT,
        includeSummary: Boolean = INCLUDES_SUMMARY,
        excludeEntityTypes: List<String> = emptyList(),
    ): GatheredContext {
        val options = GatherResourceRequestOptions(
            depth = depth,
            maxResources = maxResources,
            includeContent = includeContent,
            includeSummary = includeSummary,
            excludeEntityTypes = excludeEntityTypes.takeIf { it.isNotEmpty() },
        )
        return links.request(Operations.GATHER_RESOURCE_REQUESTED, GatherResourceRequest(resourceId = resourceId, options = options)).response
    }

    /** `resource`, for Java. */
    @JvmExposeBoxed
    public fun resourceFuture(
        resourceId: ResourceId,
        depth: Long,
        maxResources: Long,
        includeContent: Boolean,
        includeSummary: Boolean,
        excludeEntityTypes: List<String>,
    ): CompletableFuture<GatheredContext> = links.future { resource(resourceId, depth, maxResources, includeContent, includeSummary, excludeEntityTypes) }

    /** The annotations elsewhere that refer to a resource: a live query. */
    @JvmExposeBoxed
    public fun referencedBy(resourceId: ResourceId): Cached<List<GetReferencedByResponseReferencedByItem>> =
        live.query(Keyed(live.referencedBy, resourceId, { it }, links.transport to resourceId))
}
