package semiont.namespaces

import semiont.bus.LIMITS_OPERATIONS
import semiont.bus.Operations
import semiont.cache.Cache
import semiont.cache.CacheQuery
import semiont.cache.CacheRefreshWhen
import semiont.cache.Cached
import semiont.cache.KeptCaches
import semiont.cache.PERSISTED_QUERIES
import semiont.cache.Source
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode
import semiont.errors.SemiontError
import semiont.registry.WHOLE_KEY
import semiont.storage.CachePersistence
import semiont.identifiers.AnnotationId
import semiont.identifiers.ResourceId
import semiont.transport.ContentTransport
import semiont.types.Annotation
import semiont.types.AttributedEvent
import semiont.types.BrowseAnnotationRequest
import semiont.types.BrowseEnginesRequest
import semiont.types.BrowseEntityTypesRequest
import semiont.types.BrowseEventsRequest
import semiont.types.BrowseResourceRequest
import semiont.types.BrowseResourcesRequest
import semiont.types.BrowseTagSchemasRequest
import semiont.types.EngineLimits
import semiont.types.GatherReferencedByRequest
import semiont.types.GetAnnotationsResponse
import semiont.types.GetReferencedByResponseReferencedByItem
import semiont.types.InferenceLimitsRequest
import semiont.types.ListResourcesResponse
import semiont.types.MatchResourcesRequest
import semiont.types.MatchResourcesResponse
import semiont.types.ResourceDescriptor
import java.util.concurrent.ConcurrentHashMap

/** How many resources a list asks for when its caller states no limit. Every SDK asks for as many: client/surface.json's cases hold each to it. */
internal const val LIST_LIMIT = 100L

/** The key of each key holder's report of its engines' limits: the name of the operation that asks it. */
internal val LIMITS_HOLDERS: List<String> = LIMITS_OPERATIONS.map { it.request.name }

private val HOLDERS = LIMITS_OPERATIONS.associateBy { it.request.name }

/** Which resources a list, or a search, is of, and which page of them. */
internal data class ResourceFilters(val limit: Long, val offset: Long, val archived: Boolean?, val entityType: String?)

/** A search for resources by text, among those its filters admit. */
internal data class ResourceSearch(val search: String, val filters: ResourceFilters)

/** What an event names: which of a split channel's rows it is, the keys a row that reaches its subject acts on, and the value an enriched event carries. */
internal data class Subject(
    val whenIs: CacheRefreshWhen? = null,
    val resource: ResourceId? = null,
    val annotation: AnnotationId? = null,
    val written: Annotation? = null,
)

/**
 * The caches a client's queries answer from, and what an event does to them.
 * One of these is a client's: `browse`, `gather` and `match` make their
 * queries over it, and the client's refresher keeps it true.
 */
internal class Live(private val links: Links, private val content: ContentTransport, persistence: CachePersistence?) : KeptCaches {
    /** The resource each annotation that was asked for is of: an annotation is kept by its own id, and a request for it names its resource too. */
    val annotationOf = ConcurrentHashMap<AnnotationId, ResourceId>()

    // Each query's cache by the query's name (client/refresh.json), apart from `limits`, which `engines` shows beside it.
    override val resource = Cache(::resourceOf, links.scope)
    val resources = Cache(::resourcesOf, links.scope)
    override val annotations = Cache(content::getAnnotations, links.scope)
    override val annotation = Cache(::annotationOf, links.scope)
    override val entityTypes = Cache({ _: String -> links.request(Operations.BROWSE_ENTITY_TYPES_REQUESTED, BrowseEntityTypesRequest).response.entityTypes }, links.scope)
    override val tagSchemas = Cache({ _: String -> links.request(Operations.BROWSE_TAG_SCHEMAS_REQUESTED, BrowseTagSchemasRequest).response.tagSchemas }, links.scope)
    val engines = Cache({ _: String -> links.request(Operations.BROWSE_ENGINES_REQUESTED, BrowseEnginesRequest).response.engines }, links.scope)

    /** Each key holder's report of its engines' limits, by the operation that asks it. */
    val limits = Cache(::limitsOf, links.scope)
    val events = Cache(::eventsOf, links.scope)
    val referencedBy = Cache(::referencedByOf, links.scope)
    val matchedResources = Cache(::searchOf, links.scope)

    private val caches: List<Cache<*, *>> = listOf(resource, resources, annotations, annotation, entityTypes, tagSchemas, engines, limits, events, referencedBy, matchedResources)

    /** The caches of the queries a client with a storage keeps. */
    private val keptCaches: List<Cache<*, *>> = PERSISTED_QUERIES.map { it.cacheIn(this) }

    init {
        persistence?.let(::attach)
    }

    /** Keep the caches in `persistence` from now on, each beginning with what was kept there. */
    fun attach(persistence: CachePersistence): Unit = PERSISTED_QUERIES.forEach { it.attach(this, persistence) }

    /** Whether every cache the client keeps is at rest: none is fetching, and none owes a save. */
    val persistenceSettled: Boolean
        get() = keptCaches.none { it.persistencePending }

    /** Whether no cache the client keeps has a fetch in flight. */
    val keptFetchesSettled: Boolean
        get() = keptCaches.none { it.keptFetchInFlight }

    /** A live query of this client, answered from `source`. */
    fun <T : Any> query(source: Source<T>): Cached<T> = Cached(source, links.scope)

    // What each cache asks.

    private suspend fun resourceOf(resourceId: ResourceId): ResourceDescriptor =
        links.request(Operations.BROWSE_RESOURCE_REQUESTED, BrowseResourceRequest(resourceId = resourceId)).response.resource

    private suspend fun resourcesOf(filters: ResourceFilters): ListResourcesResponse {
        val request = BrowseResourcesRequest(limit = filters.limit, offset = filters.offset, archived = filters.archived, entityType = filters.entityType)
        return links.request(Operations.BROWSE_RESOURCES_REQUESTED, request).response
    }

    private suspend fun annotationOf(annotationId: AnnotationId): Annotation {
        val resourceId = annotationOf[annotationId]
            ?: throw BusRequestError(BusRequestErrorCode.Rejected, "Cannot ask for annotation ${annotationId.value}: the resource it is of is not known")
        return links.request(Operations.BROWSE_ANNOTATION_REQUESTED, BrowseAnnotationRequest(resourceId = resourceId, annotationId = annotationId)).response.annotation
    }

    /**
     * The engines one key holder reports the limits of. A holder that is down,
     * silent or mistaken reports none: its engines show no limits, and the
     * engines are not held up by it for longer than a request waits.
     */
    private suspend fun limitsOf(holder: String): List<EngineLimits> = try {
        links.request(HOLDERS.getValue(holder), InferenceLimitsRequest).response.limits
    } catch (_: SemiontError) {
        emptyList()
    }

    /** A resource's events, each with who it is attributed to, asked for now. */
    suspend fun eventsOf(resourceId: ResourceId): List<AttributedEvent> =
        links.request(Operations.BROWSE_EVENTS_REQUESTED, BrowseEventsRequest(resourceId = resourceId)).response.events

    private suspend fun referencedByOf(resourceId: ResourceId): List<GetReferencedByResponseReferencedByItem> =
        links.request(Operations.GATHER_REFERENCED_BY_REQUESTED, GatherReferencedByRequest(resourceId = resourceId)).response.referencedBy

    private suspend fun searchOf(search: ResourceSearch): MatchResourcesResponse {
        val filters = search.filters
        val request = MatchResourcesRequest(search = search.search, limit = filters.limit, offset = filters.offset, archived = filters.archived, entityType = filters.entityType)
        return links.request(Operations.MATCH_RESOURCES_REQUESTED, request).response
    }

    // What an event does.

    /** The event carries the value: it is written, and nothing is asked for. Only an annotation is ever carried. */
    fun write(query: CacheQuery, subject: Subject) {
        val resource = subject.resource ?: return
        val written = subject.written ?: return
        when (query) {
            // Into the resource's list, when the client holds it: where the annotation was, or at its end.
            CacheQuery.Annotations -> annotations.patch(resource) { held ->
                val listed = held.annotations.map { if (it.id == written.id) written else it }
                held.copy(annotations = if (held.annotations.any { it.id == written.id }) listed else listed + written)
            }
            CacheQuery.Annotation -> {
                annotationOf[written.id] = resource
                annotation.set(written.id, written)
            }
            else -> Unit
        }
    }

    /**
     * The event says the entity is gone; only an annotation is ever said to be.
     * One the cache holds is ended as not found. What says which resource it was
     * of is kept: an observer arriving at the ended key asks the service, and
     * that request names the resource.
     */
    fun remove(query: CacheQuery, subject: Subject) {
        val gone = subject.annotation ?: return
        if (query == CacheQuery.Annotation && annotation.known(gone)) {
            annotation.remove(gone, BusRequestError(BusRequestErrorCode.NotFound, "Annotation ${gone.value} was removed"))
        }
    }

    /** The engines are out of date, and so is what each key holder reported. */
    fun invalidateEngines() {
        engines.invalidate(WHOLE_KEY)
        LIMITS_HOLDERS.forEach(limits::invalidate)
    }

    /** End the queries: every collector's states end. */
    fun dispose() {
        caches.forEach { it.close() }
        annotationOf.clear()
    }
}

/** The annotations of a resource's list, as its query shows them. */
internal fun listed(answer: GetAnnotationsResponse): List<Annotation> = answer.annotations

