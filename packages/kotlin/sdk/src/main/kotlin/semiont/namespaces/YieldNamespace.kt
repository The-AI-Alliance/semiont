@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.namespaces

import semiont.bus.Operations
import semiont.channels.Channels
import semiont.channels.Empty
import semiont.identifiers.ResourceId
import semiont.transport.ContentTransport
import semiont.transport.PutBinaryRequest
import semiont.transport.Upload
import semiont.types.CloneResourceWithTokenResponse
import semiont.types.ResourceDescriptor
import semiont.types.YieldCloneResourceRequest
import semiont.types.YieldCloneTokenRequest
import java.util.concurrent.CompletableFuture

/** Creating resources. */
public class YieldNamespace internal constructor(private val links: Links, private val content: ContentTransport) {
    /** Upload a resource: it began when this returns, and says what it has sent as it sends it. */
    public fun resource(data: PutBinaryRequest): Upload = content.putBinary(data)

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
