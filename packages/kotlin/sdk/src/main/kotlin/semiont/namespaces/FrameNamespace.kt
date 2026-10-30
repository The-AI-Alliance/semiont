package semiont.namespaces

import semiont.bus.Operations
import semiont.types.FrameAddEntityTypeCommand
import semiont.types.FrameAddTagSchemaCommand
import semiont.types.TagSchema
import java.util.concurrent.CompletableFuture

/** The vocabulary: what kinds of things exist. */
public class FrameNamespace internal constructor(private val links: Links) {
    /** Add an entity type: it resolves once the knowledge base has it. */
    public suspend fun addEntityType(entityType: String) {
        links.request(Operations.FRAME_ADD_ENTITY_TYPE, FrameAddEntityTypeCommand(tag = entityType))
    }

    /** `addEntityType`, for Java. */
    public fun addEntityTypeFuture(entityType: String): CompletableFuture<Unit> = links.future { addEntityType(entityType) }

    /** Add entity types, one after another. */
    public suspend fun addEntityTypes(entityTypes: List<String>) {
        for (entityType in entityTypes) addEntityType(entityType)
    }

    /** `addEntityTypes`, for Java. */
    public fun addEntityTypesFuture(entityTypes: List<String>): CompletableFuture<Unit> = links.future { addEntityTypes(entityTypes) }

    /** Add a tag schema: it resolves once the knowledge base has it. */
    public suspend fun addTagSchema(schema: TagSchema) {
        links.request(Operations.FRAME_ADD_TAG_SCHEMA, FrameAddTagSchemaCommand(schema = schema))
    }

    /** `addTagSchema`, for Java. */
    public fun addTagSchemaFuture(schema: TagSchema): CompletableFuture<Unit> = links.future { addTagSchema(schema) }
}
