@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.namespaces

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.runningFold
import semiont.bus.Operations
import semiont.cache.Cache
import semiont.cache.CacheState
import semiont.cache.Cached
import semiont.cache.Keyed
import semiont.cache.Source
import semiont.cache.shown
import semiont.channels.Channels
import semiont.identifiers.AnnotationId
import semiont.identifiers.ResourceId
import semiont.resources.decodeRepresentation
import semiont.transport.Content
import semiont.transport.ContentStream
import semiont.transport.ContentTransport
import semiont.transport.ResourceHold
import semiont.types.AnchoredTextAnswer
import semiont.types.Annotation
import semiont.types.AttributedEvent
import semiont.types.BrowseAnnotationHistoryRequest
import semiont.types.BrowseClickEvent
import semiont.types.BrowseDirectoryRequest
import semiont.types.BrowseDirectoryRequestSort
import semiont.types.BrowseDirectoryResultResponse
import semiont.types.BrowseEventsRequest
import semiont.types.BrowseKbRequest
import semiont.types.BrowseResourceOpenEvent
import semiont.types.BrowseResourceViewedEvent
import semiont.types.EngineEntry
import semiont.types.EngineLimits
import semiont.types.GetAnnotationHistoryResponse
import semiont.types.GetResourceResponse
import semiont.types.InferenceLimits
import semiont.types.KbDescription
import semiont.types.ListResourcesResponse
import semiont.types.ResourceDescriptor
import semiont.types.TagSchema
import java.util.concurrent.CompletableFuture

/** One of the knowledge base's engines: its entry, and the engine's limits when the service holding its provider's credentials reported them. */
public data class EngineWithLimits(public val entry: EngineEntry, public val limits: InferenceLimits?)

/** The engines with each reported engine's limits on its entries. */
private fun joined(engines: List<EngineEntry>, reported: List<EngineLimits>): List<EngineWithLimits> {
    val byEngine = reported.reversed().associate { it.engine to it.limits }
    return engines.map { entry -> EngineWithLimits(entry, byEngine[entry.engine]) }
}

/**
 * The engines with each key holder's limits joined on. The engines are asked
 * for first; a holder that has not answered delays only its own engines'
 * limits, and one that answered nothing reports none.
 */
private class Engines(private val live: Live) : Source<List<EngineWithLimits>> {
    override suspend fun fresh(): List<EngineWithLimits> = coroutineScope {
        val engines = async(start = CoroutineStart.UNDISPATCHED) { live.engines.fetch(WHOLE) }
        val reports = LIMITS_HOLDERS.map { async(start = CoroutineStart.UNDISPATCHED) { live.limits.fetch(it) } }
        joined(engines.await(), reports.awaitAll().flatten())
    }

    override fun watch(): Flow<CacheState<List<EngineWithLimits>>> {
        val engines = live.engines.observe(WHOLE)
        // A holder's report is pending, then what it reported: it never fails (`Live`).
        val reports = LIMITS_HOLDERS.map { holder ->
            live.limits.observe(holder).runningFold(emptyList<EngineLimits>()) { reported, state -> (state as? CacheState.Ready)?.value ?: reported }
        }
        val reported = if (reports.isEmpty()) flowOf(emptyList()) else combine(reports) { it.toList().flatten() }
        // A report that changes nothing a collector is shown is not a state.
        return combine(engines, reported) { entries, limits -> entries.shown { joined(it, limits) } }.distinctUntilChanged()
    }

    override fun invalidate(): Unit = live.invalidateEngines()

    override fun hold(): ResourceHold? = null
}

/** Reads: one-shot reads, and this viewer's own signals. */
public class BrowseNamespace internal constructor(private val links: Links, private val content: ContentTransport, private val live: Live) {
    /** A query of one resource: collecting it holds the resource's scope. */
    private fun <K : Any, V : Any, T : Any> of(resourceId: ResourceId, cache: Cache<K, V>, key: K, view: (V) -> T): Cached<T> =
        live.query(Keyed(cache, key, view, links.transport to resourceId))

    /** A resource's description: a live query. */
    @JvmExposeBoxed
    public fun resource(resourceId: ResourceId): Cached<ResourceDescriptor> = of(resourceId, live.resource, resourceId) { it }

    /**
     * A page of the resources the filters admit, the first hundred when
     * nothing is stated, `offset` of them passed over before the page begins:
     * a live query. It is kept true by what every client hears and by the
     * events of the resources this client holds the scope of, and by nothing
     * else. Finding resources by text is `match.resources`.
     */
    @JvmOverloads
    public fun resources(limit: Long = LIST_LIMIT, offset: Long = 0, archived: Boolean? = null, entityType: String? = null): Cached<ListResourcesResponse> =
        live.query(Keyed(live.lists, ResourceFilters(limit, offset, archived, entityType), { it }))

    /** A resource's annotations: a live query. */
    @JvmExposeBoxed
    public fun annotations(resourceId: ResourceId): Cached<List<Annotation>> = of(resourceId, live.annotations, resourceId, ::listed)

    /** One annotation of a resource: a live query. */
    @JvmExposeBoxed
    public fun annotation(resourceId: ResourceId, annotationId: AnnotationId): Cached<Annotation> {
        live.annotationOf[annotationId] = resourceId
        return of(resourceId, live.annotation, annotationId) { it }
    }

    /** The knowledge base's entity types: a live query. */
    public fun entityTypes(): Cached<List<String>> = live.query(Keyed(live.entityTypes, WHOLE, { it }))

    /** The knowledge base's tag schemas: a live query. */
    public fun tagSchemas(): Cached<List<TagSchema>> = live.query(Keyed(live.tagSchemas, WHOLE, { it }))

    /** The knowledge base's engines, with each engine's limits as the services holding its provider's credentials report them: a live query. */
    public fun engines(): Cached<List<EngineWithLimits>> = live.query(Engines(live))

    /** A resource's events, each with who it is attributed to: a live query. */
    @JvmExposeBoxed
    public fun events(resourceId: ResourceId): Cached<List<AttributedEvent>> = of(resourceId, live.events, resourceId) { it }

    /** A resource's description as linked data: itself, its annotations and the references to it. */
    public suspend fun resourceGraph(resourceId: ResourceId): GetResourceResponse = content.getResourceGraph(resourceId)

    /** `resourceGraph`, for Java. */
    @JvmExposeBoxed
    public fun resourceGraphFuture(resourceId: ResourceId): CompletableFuture<GetResourceResponse> = links.future { resourceGraph(resourceId) }

    /** A resource's anchored text: the text of its content with where each run is on a page, a stored decline, or why there is none. */
    public suspend fun resourceAnchoredText(resourceId: ResourceId): AnchoredTextAnswer = content.getAnchoredText(resourceId)

    /** `resourceAnchoredText`, for Java. */
    @JvmExposeBoxed
    public fun resourceAnchoredTextFuture(resourceId: ResourceId): CompletableFuture<AnchoredTextAnswer> = links.future { resourceAnchoredText(resourceId) }

    /**
     * A resource's bytes as the text they are: in the charset their content
     * type states, UTF-8 when it states none, and in the encoding of a
     * byte-order mark where they begin with one. A resource whose text is not
     * its bytes is refused, as a charset that is not decoded is.
     */
    public suspend fun resourceContent(resourceId: ResourceId): String {
        val read = content.getBinary(resourceId)
        return decodeRepresentation(read.bytes, read.contentType)
    }

    /** `resourceContent`, for Java. */
    @JvmExposeBoxed
    public fun resourceContentFuture(resourceId: ResourceId): CompletableFuture<String> = links.future { resourceContent(resourceId) }

    /** A resource's bytes, unchanged, with their media type. */
    public suspend fun resourceRepresentation(resourceId: ResourceId): Content = content.getBinary(resourceId)

    /** `resourceRepresentation`, for Java. */
    @JvmExposeBoxed
    public fun resourceRepresentationFuture(resourceId: ResourceId): CompletableFuture<Content> = links.future { resourceRepresentation(resourceId) }

    /** The same, as they arrive. */
    public suspend fun resourceRepresentationStream(resourceId: ResourceId): ContentStream = content.getBinaryStream(resourceId)

    /** `resourceRepresentationStream`, for Java. */
    @JvmExposeBoxed
    public fun resourceRepresentationStreamFuture(resourceId: ResourceId): CompletableFuture<ContentStream> = links.future { resourceRepresentationStream(resourceId) }

    /** A resource's events, each with who it is attributed to, asked for now. */
    public suspend fun resourceEvents(resourceId: ResourceId): List<AttributedEvent> =
        links.request(Operations.BROWSE_EVENTS_REQUESTED, BrowseEventsRequest(resourceId = resourceId)).response.events

    /** `resourceEvents`, for Java. */
    @JvmExposeBoxed
    public fun resourceEventsFuture(resourceId: ResourceId): CompletableFuture<List<AttributedEvent>> = links.future { resourceEvents(resourceId) }

    /** The events of one annotation. */
    public suspend fun annotationHistory(resourceId: ResourceId, annotationId: AnnotationId): GetAnnotationHistoryResponse =
        links.request(Operations.BROWSE_ANNOTATION_HISTORY_REQUESTED, BrowseAnnotationHistoryRequest(resourceId = resourceId, annotationId = annotationId)).response

    /** `annotationHistory`, for Java. */
    @JvmExposeBoxed
    public fun annotationHistoryFuture(resourceId: ResourceId, annotationId: AnnotationId): CompletableFuture<GetAnnotationHistoryResponse> =
        links.future { annotationHistory(resourceId, annotationId) }

    /** The entries of a directory of the knowledge base's tree: its root when no path is stated, by name when no order is. */
    public suspend fun files(path: String = ".", sort: BrowseDirectoryRequestSort = BrowseDirectoryRequestSort.Name): BrowseDirectoryResultResponse =
        links.request(Operations.BROWSE_DIRECTORY_REQUESTED, BrowseDirectoryRequest(path = path, sort = sort)).response

    /** `files`, for Java. */
    public fun filesFuture(path: String, sort: BrowseDirectoryRequestSort): CompletableFuture<BrowseDirectoryResultResponse> = links.future { files(path, sort) }

    /** What the knowledge base says of itself: its name and domain, and its working tree's branch. Asked every time: a branch changes with no event to say so. */
    public suspend fun kb(): KbDescription = links.request(Operations.BROWSE_KB_REQUESTED, BrowseKbRequest).response

    /** `kb`, for Java. */
    public fun kbFuture(): CompletableFuture<KbDescription> = links.future { kb() }

    /** Signal: open an annotation for this viewer. */
    @JvmExposeBoxed
    public fun click(annotationId: AnnotationId): Unit = links.signal(Channels.BROWSE_CLICK, BrowseClickEvent(annotationId = annotationId))

    /** Signal: open a resource for this viewer. */
    @JvmExposeBoxed
    public fun openResource(resourceId: ResourceId): Unit = links.signal(Channels.BROWSE_RESOURCE_OPEN, BrowseResourceOpenEvent(resourceId = resourceId))

    /** Report that this viewer is looking at a resource. It goes over the wire, and nobody awaits it. */
    @JvmExposeBoxed
    public fun resourceViewed(resourceId: ResourceId): Unit = links.report(Channels.BROWSE_RESOURCE_VIEWED, BrowseResourceViewedEvent(resourceId = resourceId))
}
