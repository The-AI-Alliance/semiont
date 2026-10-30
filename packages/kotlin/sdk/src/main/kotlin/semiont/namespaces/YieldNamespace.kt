@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.namespaces

import semiont.Delegation
import semiont.Timings
import semiont.bus.Operations
import semiont.channels.Channels
import semiont.channels.Empty
import semiont.identifiers.ResourceId
import semiont.transport.ContentTransport
import semiont.transport.PutBinaryRequest
import semiont.transport.Upload
import semiont.types.CloneResourceWithTokenResponse
import semiont.types.GatheredContextFocusAnnotation
import semiont.types.GatheredContextFocusResource
import semiont.types.GenerationJobParams
import semiont.types.ResourceDescriptor
import semiont.types.YieldCloneResourceRequest
import semiont.types.YieldCloneTokenRequest
import semiont.types.YieldJobCompleteCommand
import semiont.types.YieldJobCreateCommand
import java.util.concurrent.CompletableFuture

/**
 * How long a followed generation may say nothing before its follower gives up
 * on it: a floor, and a wait that grows with the length asked for. A
 * generation says nothing while its model writes, so the silence it is
 * allowed depends on how much it was asked to write.
 */
internal fun generationStallDeadlineMs(maxTokens: Double?): Long {
    val tokens = maxTokens?.coerceAtLeast(0.0) ?: Timings.GENERATION_STALL_ASSUMED_TOKENS_COUNT.toDouble()
    return maxOf(Timings.GENERATION_STALL_FLOOR_MS, Math.round(Timings.GENERATION_STALL_PER_TOKEN_MS * tokens))
}

/** Creating resources: by upload, by a generation delegated as a job, by cloning. */
public class YieldNamespace internal constructor(private val links: Links, private val content: ContentTransport) {
    /** Upload a resource: it began when this returns, and says what it has sent as it sends it. */
    public fun resource(data: PutBinaryRequest): Upload = content.putBinary(data)

    /**
     * Delegate the making of a resource from a gathered context, as a `yield`
     * job: its progress and its completion. The context's focus says what the
     * job is about, so the job names no resource. A follower that hears
     * nothing for `stallDeadlineMs`, or for a wait that grows with
     * `params.maxTokens` when none is stated, asks for that job to be
     * cancelled and ends as stalled.
     */
    @JvmOverloads
    public fun delegate(params: GenerationJobParams, stallDeadlineMs: Long? = null): Delegation<YieldJobCompleteCommand> {
        val about = when (val focus = params.context.focus) {
            is GatheredContextFocusResource -> focus.resource.id
            is GatheredContextFocusAnnotation -> focus.sourceResource.id
        }
        val within = stallDeadlineMs ?: generationStallDeadlineMs(params.maxTokens)
        return follow(links, YieldJobCreateCommand(params = params), YieldJobCompleteCommand::class.java, about, within)
    }

    /** A token another knowledge base, or this one, clones a resource by. */
    public suspend fun cloneToken(resourceId: ResourceId): CloneResourceWithTokenResponse =
        links.request(Operations.YIELD_CLONE_TOKEN_REQUESTED, YieldCloneTokenRequest(resourceId = resourceId)).response

    /** `cloneToken`, for Java. */
    @JvmExposeBoxed
    public fun cloneTokenFuture(resourceId: ResourceId): CompletableFuture<CloneResourceWithTokenResponse> = links.future { cloneToken(resourceId) }

    /** The resource a clone token reads. */
    public suspend fun fromToken(token: String): ResourceDescriptor =
        links.request(Operations.YIELD_CLONE_RESOURCE_REQUESTED, YieldCloneResourceRequest(token = token)).response.sourceResource

    /** `fromToken`, for Java. */
    public fun fromTokenFuture(token: String): CompletableFuture<ResourceDescriptor> = links.future { fromToken(token) }

    /** Signal: a clone is begun in this viewer. */
    public fun clone(): Unit = links.signal(Channels.YIELD_CLONE, Empty)
}
