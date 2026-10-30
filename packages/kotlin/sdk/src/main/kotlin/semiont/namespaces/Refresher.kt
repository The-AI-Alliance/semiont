package semiont.namespaces

import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import semiont.bus.decoded
import semiont.cache.CACHE_REFRESH
import semiont.cache.Cache
import semiont.cache.CacheQuery
import semiont.cache.CacheRefreshReach
import semiont.cache.CacheRefreshTrigger
import semiont.cache.CacheRefreshWhen
import semiont.channels.Channels
import semiont.identifiers.AnnotationId
import semiont.identifiers.ResourceId
import semiont.transport.ConnectionState
import semiont.transport.Frame

/** The triggers that are events, by the channel each is. */
private val EVENTS: Map<String, CacheRefreshTrigger> =
    CacheRefreshTrigger.entries.filter { it != CacheRefreshTrigger.Reopened }.associateBy { it.wire }

/**
 * B19: per key, the first refetch an event asks for runs at once and opens a
 * window. Any more inside it are owed, and run as one when it closes, which
 * opens the next. So a storm of events costs a refetch per key per window, and
 * the last event is always reflected.
 */
private class Windows(private val links: Links, private val lastingMs: Long) {
    private class Window(val refetch: () -> Unit, var closing: Job? = null, var owed: Boolean = false)

    private val open = HashMap<String, Window>()
    private var disposed = false

    /** Ask again for `key`, by `refetch`: what asks for one key is the same whichever event asked. */
    fun run(key: String, refetch: () -> Unit) {
        synchronized(this) {
            if (disposed) return
            open[key]?.let {
                it.owed = true
                return
            }
            val window = Window(refetch)
            open[key] = window
            window.closing = links.scope.launch {
                delay(lastingMs)
                close(key)
            }
        }
        refetch()
    }

    private fun close(key: String) {
        val window = synchronized(this) { open.remove(key) } ?: return
        if (window.owed) run(key, window.refetch)
    }

    /** Every window closes, and what each owed is dropped. */
    fun dispose() {
        val closing = synchronized(this) {
            disposed = true
            open.values.toList().also { open.clear() }
        }
        closing.forEach { it.closing?.cancel() }
    }
}

private fun annotationNamed(payload: JsonObject): AnnotationId? = (payload["annotationId"] as? JsonPrimitive)?.takeIf { it.isString }?.let { AnnotationId.parse(it.content) }

/** What an event names. Each arm states it for its trigger. Throws `IllegalArgumentException` for a payload that is not its channel's. */
private fun named(trigger: CacheRefreshTrigger, payload: JsonObject): Subject = when (trigger) {
    // No event: the stream's reopening names nothing.
    CacheRefreshTrigger.Reopened -> Subject()
    CacheRefreshTrigger.BusResumeGap -> Subject(resource = decoded(Channels.BUS_RESUME_GAP, payload).scope)
    CacheRefreshTrigger.MarkAdded -> Subject(resource = decoded(Channels.MARK_ADDED, payload).resourceId)
    CacheRefreshTrigger.MarkRemoved -> decoded(Channels.MARK_REMOVED, payload).let { Subject(resource = it.resourceId, annotation = annotationNamed(it.payload)) }
    CacheRefreshTrigger.MarkDeleteOk -> Subject(annotation = decoded(Channels.MARK_DELETE_OK, payload).response.annotationId)
    CacheRefreshTrigger.MarkBodyUpdated -> decoded(Channels.MARK_BODY_UPDATED, payload).let { updated ->
        updated.annotation?.let { Subject(CacheRefreshWhen.Enriched, updated.resourceId, it.id, it) }
            ?: Subject(CacheRefreshWhen.Unenriched, updated.resourceId, annotationNamed(updated.payload))
    }
    CacheRefreshTrigger.MarkEntityTagAdded -> Subject(resource = decoded(Channels.MARK_ENTITY_TAG_ADDED, payload).resourceId)
    CacheRefreshTrigger.MarkEntityTagRemoved -> Subject(resource = decoded(Channels.MARK_ENTITY_TAG_REMOVED, payload).resourceId)
    CacheRefreshTrigger.MarkArchived -> Subject(resource = decoded(Channels.MARK_ARCHIVED, payload).resourceId)
    CacheRefreshTrigger.MarkUnarchived -> Subject(resource = decoded(Channels.MARK_UNARCHIVED, payload).resourceId)
    // What is heard by every client: its resource is the one it records, not a scope the client holds.
    CacheRefreshTrigger.YieldCreated -> Subject(resource = decoded(Channels.YIELD_CREATED, payload).resourceId)
    CacheRefreshTrigger.YieldUpdated -> Subject(resource = decoded(Channels.YIELD_UPDATED, payload).resourceId)
    CacheRefreshTrigger.YieldCloned -> Subject(resource = decoded(Channels.YIELD_CLONED, payload).resourceId)
    CacheRefreshTrigger.YieldMoved -> Subject(resource = decoded(Channels.YIELD_MOVED, payload).resourceId)
    CacheRefreshTrigger.FrameEntityTypeAdded -> decoded(Channels.FRAME_ENTITY_TYPE_ADDED, payload).let { Subject() }
    CacheRefreshTrigger.FrameTagSchemaAdded -> decoded(Channels.FRAME_TAG_SCHEMA_ADDED, payload).let { Subject() }
}

/**
 * What keeps a client's queries true: client/refresh.json, applied to the
 * client's caches. Each event on the bus, and the reopening of a dropped
 * stream, asks again for the queries its row names, writes the ones whose new
 * value the event carries, and ends the ones whose entity is gone. An event
 * acts only on a key its cache holds, and the refetches one key is asked for
 * inside a window are one refetch (docs/protocol/CACHE-SEMANTICS.md, B12 to
 * B13b, B19, B20). A client has one, listening from when the client is made
 * until it closes.
 */
internal class Refresher(private val links: Links, private val live: Live) {
    private val windows = Windows(links, links.timing.invalidationWindowMs)

    /** Listen, from now on. */
    fun start() {
        // Listening before the work that reads has begun: nothing said meanwhile is missed.
        val frames = links.own.framesAmong(EVENTS.keys)
        links.scope.launch { frames.collect(::heard) }
        links.scope.launch { reopenings() }
    }

    private fun heard(frame: Frame) {
        val trigger = EVENTS.getValue(frame.channel)
        val subject = try {
            named(trigger, frame.payload)
        } catch (_: IllegalArgumentException) {
            // An event that cannot be read: something changed and nothing says what. Everything held is asked for again, as after a gap.
            CacheQuery.entries.forEach { refetch(it, Subject(), CacheRefreshReach.Held) }
            return
        }
        refresh(trigger, subject)
    }

    /** B13: the stream is open again having left `open`, which only a drop does. A changed subscription is handed over with the state still `open`, and misses nothing. */
    private suspend fun reopenings() {
        var opened = false
        var left = false
        links.transport.state.collect { now ->
            if (now == ConnectionState.Open) {
                if (left) refresh(CacheRefreshTrigger.Reopened, Subject())
                opened = true
                left = false
            } else {
                left = opened
            }
        }
    }

    private fun refresh(trigger: CacheRefreshTrigger, subject: Subject) {
        val row = CACHE_REFRESH.getValue(trigger).firstOrNull { it.whenIs == subject.whenIs } ?: return
        row.writes.forEach { live.write(it, subject) }
        row.removes.forEach { live.remove(it, subject) }
        row.refetches.forEach { refetch(it, subject, row.reach) }
    }

    /** Ask again for one key, when the cache holds it (B20), through the key's window (B19). */
    private fun <K : Any> again(cache: Cache<K, *>, key: K, window: String) {
        if (cache.known(key)) windows.run(window) { cache.invalidate(key) }
    }

    /** B7: ask again, for the keys the row reaches, showing what there is meanwhile. Each arm names the cache that answers its query. */
    private fun refetch(query: CacheQuery, subject: Subject, reach: CacheRefreshReach) {
        fun reached(held: List<ResourceId>): List<ResourceId> = when (reach) {
            CacheRefreshReach.Held -> held
            CacheRefreshReach.Subject -> listOfNotNull(subject.resource)
        }
        when (query) {
            CacheQuery.Resource -> reached(live.resource.keys()).forEach { again(live.resource, it, "resource/${it.value}") }
            CacheQuery.Annotations -> reached(live.annotations.keys()).forEach { again(live.annotations, it, "annotations/${it.value}") }
            CacheQuery.Events -> reached(live.events.keys()).forEach { again(live.events, it, "events/${it.value}") }
            CacheQuery.ReferencedBy -> reached(live.referencedBy.keys()).forEach { again(live.referencedBy, it, "referenced-by/${it.value}") }
            CacheQuery.Annotation -> {
                // The annotation the event names; when it names none, each one held of the resource it names.
                val annotations = when {
                    reach == CacheRefreshReach.Held -> live.annotation.keys()
                    subject.annotation != null -> listOf(subject.annotation)
                    else -> live.annotationOf.filterValues { it == subject.resource }.keys.toList()
                }
                annotations.forEach { again(live.annotation, it, "annotation/${it.value}") }
            }
            // An event does not say which lists it changes, nor which searches would now find its resource.
            CacheQuery.Resources -> windows.run("resource-lists", live.lists::invalidateAll)
            CacheQuery.MatchedResources -> windows.run("matched-resources", live.searches::invalidateAll)
            CacheQuery.EntityTypes -> again(live.entityTypes, WHOLE, "entity-types")
            CacheQuery.TagSchemas -> again(live.tagSchemas, WHOLE, "tag-schemas")
            CacheQuery.Engines -> if (live.engines.known(WHOLE)) windows.run("engines", live::invalidateEngines)
        }
    }

    /** Stop: what a window owed is dropped, and no window opens after. The client's close ends the listening. */
    fun dispose(): Unit = windows.dispose()
}
