@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.namespaces

import semiont.identifiers.ResourceId
import semiont.transport.GatewayOperations
import semiont.types.MediaTokenResponse
import semiont.types.ProtectedResourceMetadata
import semiont.types.UserResponse
import java.util.concurrent.CompletableFuture

/** The gateway's view of who is signed in. */
public class AuthNamespace internal constructor(private val links: Links, private val gateway: GatewayOperations) {
    /** Who the gateway takes this client's token for. */
    public suspend fun me(): UserResponse = gateway.getCurrentUser()

    /** `me`, for Java. */
    public fun meFuture(): CompletableFuture<UserResponse> = links.future { me() }

    /** A token that reads one resource's media, for a viewer that cannot send this client's token. */
    public suspend fun mediaToken(resourceId: ResourceId): MediaTokenResponse = gateway.getMediaToken(resourceId)

    /** `mediaToken`, for Java. */
    @JvmExposeBoxed
    public fun mediaTokenFuture(resourceId: ResourceId): CompletableFuture<MediaTokenResponse> = links.future { mediaToken(resourceId) }

    /** What the knowledge base says of how it is signed in to (RFC 9728). */
    public suspend fun protectedResourceMetadata(): ProtectedResourceMetadata = gateway.getProtectedResourceMetadata()

    /** `protectedResourceMetadata`, for Java. */
    public fun protectedResourceMetadataFuture(): CompletableFuture<ProtectedResourceMetadata> = links.future { protectedResourceMetadata() }
}
