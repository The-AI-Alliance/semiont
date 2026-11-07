package semiont.namespaces

import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import semiont.bus.faultOf
import semiont.cache.CACHE_REFRESH
import semiont.cache.CACHE_REFRESH_CHANNELS
import semiont.cache.Cache
import semiont.cache.CacheQuery
import semiont.cache.CacheRefreshChannel
import semiont.cache.CacheRefreshReach
import semiont.cache.CacheRefreshTrigger
import semiont.cache.CacheRefreshWhen
import semiont.errors.TransportError
import semiont.identifiers.AnnotationId
import semiont.identifiers.ResourceId
import semiont.registry.WHOLE_KEY
import semiont.transport.Carried
import semiont.transport.ConnectionState
import semiont.transport.Frame
import semiont.transport.FrameRefusal
import semiont.types.Annotation
import semiont.types.wireJson

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

    /** Whether a window that is open holds a refetch it has not yet run. */
    val owesARefetch: Boolean
        get() = synchronized(this) { open.values.any { it.owed } }

    /** Every window closes, and what each owed is dropped. */
    fun dispose() {
        val closing = synchronized(this) {
            disposed = true
            open.values.toList().also { open.clear() }
        }
        closing.forEach { it.closing?.cancel() }
    }
}

/**
 * What `way` names in `event`, as `read` reads it: none where the row states
 * no way, or where its member, or a member it passes through, is absent or
 * null. A member it passes through that is present and is no object, or the
 * one it ends at that `read` does not read, makes the event `unreadable`.
 */
private inline fun <T : Any> memberAt(event: JsonObject, way: List<String>?, read: (JsonElement) -> T?, unreadable: () -> Nothing): T? {
    var member: JsonElement = event
    for (name in way ?: return null) {
        val within = member as? JsonObject ?: unreadable()
        member = within[name]?.takeUnless { it is JsonNull } ?: return null
    }
    return read(member) ?: unreadable()
}

private fun textOf(member: JsonElement): String? = (member as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun resourceIdOf(member: JsonElement): ResourceId? = textOf(member)?.let { ResourceId.parse(it) }

private fun annotationIdOf(member: JsonElement): AnnotationId? = textOf(member)?.let { AnnotationId.parse(it) }

private fun annotationOf(member: JsonElement): Annotation? {
    if (faultOf(Annotation.serializer().descriptor, member) != null) return null
    return try {
        wireJson.decodeFromJsonElement(Annotation.serializer(), member)
    } catch (_: IllegalArgumentException) {
        null
    }
}

/**
 * What an event on `channel` names, by the ways of its row
 * (client/refresh.json); null when it cannot be read: its channel's reading
 * refuses it, or a member a way names is present and is not what it names. A
 * split channel's event is enriched when the member its enriched row carries
 * is present, and is read there as what that row carries.
 */
private fun subjectOf(channel: CacheRefreshChannel, event: JsonObject): Subject? {
    try {
        channel.read(event)
    } catch (_: TransportError) {
        return null
    }
    val rows = CACHE_REFRESH.getValue(channel.trigger)
    val enriched = rows.singleOrNull { it.whenIs == CacheRefreshWhen.Enriched }
    val row = when {
        enriched == null -> rows.single()
        memberAt(event, enriched.carries, ::annotationOf) { return null } == null -> rows.single { it.whenIs == CacheRefreshWhen.Unenriched }
        else -> enriched
    }
    return Subject(
        whenIs = row.whenIs,
        resource = memberAt(event, row.names.resource, ::resourceIdOf) { return null },
        annotation = memberAt(event, row.names.annotation, ::annotationIdOf) { return null },
        written = memberAt(event, row.carries, ::annotationOf) { return null },
    )
}

/**
 * What keeps a client's queries true: client/refresh.json, applied to the
 * client's caches. Each event on the bus, and the reopening of a dropped
 * stream, asks again for the queries its row names, writes the ones whose new
 * value the event carries, and ends the ones whose entity is gone. An event
 * acts only on a key its cache holds, and the refetches one key is asked for
 * inside a window are one refetch (protocol/contract/CACHE-SEMANTICS.md, B12 to
 * B13b, B19, B20). A client has one, listening from when the client is made
 * until it closes.
 */
internal class Refresher(private val links: Links, private val live: Live) {
    private val windows = Windows(links, links.timing.invalidationWindowMs)

    /** Listen, from now on. */
    fun start() {
        // Listening before the work that reads has begun: nothing said meanwhile is missed.
        val frames = links.own.framesAmong(CACHE_REFRESH_CHANNELS.keys)
        links.scope.launch { frames.collect(::heard) }
        links.scope.launch { reopenings() }
    }

    /** A frame on one of the table's channels: its row, or, when its channel's reading refuses it or a member its row names is not what it names, the row of an unreadable event. */
    private fun heard(carried: Carried) {
        val channel = CACHE_REFRESH_CHANNELS.getValue(carried.channel)
        val subject = when (carried) {
            is Frame -> subjectOf(channel, carried.payload)
            is FrameRefusal -> null
        }
        if (subject == null) refresh(CacheRefreshTrigger.Unreadable, Subject()) else refresh(channel.trigger, subject)
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
        val row = CACHE_REFRESH.getValue(trigger).single { it.whenIs == subject.whenIs }
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
            CacheQuery.EntityTypes -> again(live.entityTypes, WHOLE_KEY, CacheQuery.EntityTypes.wire)
            CacheQuery.TagSchemas -> again(live.tagSchemas, WHOLE_KEY, CacheQuery.TagSchemas.wire)
            CacheQuery.Engines -> if (live.engines.known(WHOLE_KEY)) windows.run("engines", live::invalidateEngines)
        }
    }

    /** Whether an event's refetch is owed: a window holds one it has not yet run (B19). */
    val owesARefetch: Boolean
        get() = windows.owesARefetch

    /** Stop: what a window owed is dropped, and no window opens after. The client's close ends the listening. */
    fun dispose(): Unit = windows.dispose()
}
