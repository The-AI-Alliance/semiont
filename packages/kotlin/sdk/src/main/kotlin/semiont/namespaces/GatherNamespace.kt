@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.namespaces

import semiont.bus.Operations
import semiont.identifiers.ResourceId
import semiont.types.GatherResourceRequest
import semiont.types.GatherResourceRequestOptions
import semiont.types.GatheredContext
import java.util.concurrent.CompletableFuture

/** Assembling the context a model is given, and what refers to a resource. */
public class GatherNamespace internal constructor(private val links: Links) {
    /**
     * The context around a whole resource. With nothing stated: two hops of the
     * graph, ten resources, their content, and no summary. `depth` is how many
     * links out from the resource the graph reaches, 1 to 3, nearest first. An
     * empty exclusion excludes nothing, and is not sent.
     */
    public suspend fun resource(
        resourceId: ResourceId,
        depth: Long = 2,
        maxResources: Long = 10,
        includeContent: Boolean = true,
        includeSummary: Boolean = false,
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
}
