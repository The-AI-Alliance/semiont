package semiont.namespaces

import semiont.transport.GatewayOperations
import semiont.types.HealthResponse
import semiont.types.StatusResponse
import java.util.concurrent.CompletableFuture

/** What the knowledge base says about itself. */
public class SystemNamespace internal constructor(private val links: Links, private val gateway: GatewayOperations) {
    /** Whether the gateway is up. */
    public suspend fun healthCheck(): HealthResponse = gateway.healthCheck()

    /** `healthCheck`, for Java. */
    public fun healthCheckFuture(): CompletableFuture<HealthResponse> = links.future { healthCheck() }

    /** What the knowledge base reports of its own state. */
    public suspend fun status(): StatusResponse = gateway.getStatus()

    /** `status`, for Java. */
    public fun statusFuture(): CompletableFuture<StatusResponse> = links.future { status() }
}
