@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.state

import semiont.SemiontClient
import semiont.StateUnit
import semiont.errors.SemiontError
import semiont.identifiers.AnnotationId
import semiont.identifiers.ResourceId
import semiont.namespaces.CONTEXT_WINDOW
import semiont.namespaces.INCLUDES_CONTENT
import semiont.namespaces.INCLUDES_SUMMARY
import semiont.namespaces.RESOURCE_DEPTH
import semiont.namespaces.RESOURCE_LIMIT
import semiont.transport.Variable
import semiont.transport.Watched
import semiont.types.GatheredContext

/** One gather's state: its context, whether it is being gathered, and the failure it met. */
private class Slot {
    val context = Variable<GatheredContext?>(null)
    val loading = Variable(false)
    val error = Variable<SemiontError?>(null)

    fun begin() {
        loading.set(true)
        error.set(null)
        context.set(null)
    }

    /** Hold what `gathering` comes to: the context is there before the gather is said to be over, for a reader told so. */
    suspend fun land(gathering: suspend () -> GatheredContext) {
        try {
            context.set(gathering())
        } catch (failure: SemiontError) {
            error.set(failure)
        }
        loading.set(false)
    }

    fun end() {
        context.end()
        loading.end()
        error.end()
    }
}

/**
 * Gathering, as state: the context around an annotation of one resource, and
 * the context around a whole resource, each with whether it is being gathered
 * and the failure it met. The two are held apart because both can be in
 * flight at once. Each is asked of the unit itself, so a gather asked of one
 * resource's unit reaches no other. A new request clears what the last one
 * left. Requests are not cancelled by the next: each lands when it is
 * answered.
 */
public class GatherStateUnit @JvmExposeBoxed constructor(private val client: SemiontClient, private val resourceId: ResourceId) : StateUnit {
    private val annotation = Slot()
    private val asked = Variable<AnnotationId?>(null)
    private val resource = Slot()
    private val tasks = Tasks(client.links.scope.coroutineContext)

    @Volatile
    private var closed = false

    /** The context around the annotation last asked about. */
    public val context: Watched<GatheredContext?> = annotation.context.reading()

    /** Whether the annotation last asked about is being gathered. */
    public val loading: Watched<Boolean> = annotation.loading.reading()

    /** Why the gather of the annotation last asked about failed, or none. */
    public val error: Watched<SemiontError?> = annotation.error.reading()

    /** The annotation last asked about. */
    public val annotationId: Watched<AnnotationId?> = asked.reading()

    /** The context around the resource last asked about. */
    public val resourceContext: Watched<GatheredContext?> = resource.context.reading()

    /** Whether the resource last asked about is being gathered. */
    public val resourceLoading: Watched<Boolean> = resource.loading.reading()

    /** Why the gather of the resource last asked about failed, or none. */
    public val resourceError: Watched<SemiontError?> = resource.error.reading()

    /** Gather the context around an annotation of this unit's resource, with what `client.gather.annotation` takes. */
    @JvmOverloads
    @JvmExposeBoxed
    public fun gatherAnnotation(
        annotationId: AnnotationId,
        contextWindow: Long = CONTEXT_WINDOW,
        includeSourceContext: Boolean? = null,
        includeTargetContext: Boolean? = null,
    ) {
        if (closed) return
        annotation.begin()
        asked.set(annotationId)
        tasks.run {
            annotation.land { client.gather.annotation(resourceId, annotationId, contextWindow, includeSourceContext, includeTargetContext).await().response }
        }
    }

    /** Gather the context around a whole resource, with what `client.gather.resource` takes. */
    @JvmOverloads
    @JvmExposeBoxed
    public fun gatherResource(
        resourceId: ResourceId,
        depth: Long = RESOURCE_DEPTH,
        maxResources: Long = RESOURCE_LIMIT,
        includeContent: Boolean = INCLUDES_CONTENT,
        includeSummary: Boolean = INCLUDES_SUMMARY,
        excludeEntityTypes: List<String> = emptyList(),
    ) {
        if (closed) return
        resource.begin()
        tasks.run {
            resource.land { client.gather.resource(resourceId, depth, maxResources, includeContent, includeSummary, excludeEntityTypes) }
        }
    }

    /** Stop gathering: what is under way is abandoned, and every state ends. */
    override fun close() {
        closed = true
        tasks.stop()
        annotation.end()
        asked.end()
        resource.end()
    }
}
