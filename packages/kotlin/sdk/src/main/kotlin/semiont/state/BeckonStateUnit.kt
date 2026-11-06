@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.state

import semiont.SemiontClient
import semiont.StateUnit
import semiont.bus.heard
import semiont.channels.Channels
import semiont.identifiers.AnnotationId
import semiont.identifiers.ResourceId
import semiont.transport.Carried
import semiont.transport.Delivered
import semiont.transport.FrameRefusal
import semiont.transport.Variable
import semiont.transport.Watched
import semiont.types.BeckonFocusEvent
import semiont.types.BeckonSparkleEvent

/**
 * Attention, as the state of a viewer of one resource: which annotation is
 * hovered. It hears the viewer's hover (`client.beckon.hover`) and holds it,
 * and sparkles an annotation the moment it is hovered. It hears an annotation
 * opened, by this viewer or by another participant driving it, and turns the
 * viewer's focus to it. Every focus it says names its resource.
 */
public class BeckonStateUnit @JvmExposeBoxed constructor(private val client: SemiontClient, private val resourceId: ResourceId) : StateUnit {
    private val hovered = Variable<AnnotationId?>(null)
    private val tasks = Tasks(client.links.scope.coroutineContext)

    @Volatile
    private var closed = false

    /** The annotation this viewer hovers, or none. */
    public val hoveredAnnotationId: Watched<AnnotationId?> = hovered.reading()

    init {
        // One reader of both, taken now, so what is said from here on is heard in the order it was said.
        val heard = client.bus.framesAmong(listOf(Channels.BECKON_HOVER.name, Channels.BROWSE_CLICK.name))
        tasks.run {
            heard.collect { heard(it) }
        }
    }

    /** Signal: turn this viewer's focus to an annotation of its resource. */
    @JvmExposeBoxed
    public fun focus(annotationId: AnnotationId) {
        if (!closed) client.bus.publish(Channels.BECKON_FOCUS, BeckonFocusEvent(resourceId = resourceId, annotationId = annotationId), null, null)
    }

    /** Act on what was heard. A frame refused, or one whose payload is not its channel's, is nobody's to act on. */
    private fun heard(carried: Carried) {
        if (carried.channel == Channels.BECKON_HOVER.name) {
            val annotationId = when (val hover = heard(Channels.BECKON_HOVER, carried)) {
                is Delivered -> hover.payload.annotationId
                is FrameRefusal -> return
            }
            hovered.set(annotationId)
            if (annotationId != null) client.bus.publish(Channels.BECKON_SPARKLE, BeckonSparkleEvent(annotationId = annotationId), null, null)
        } else {
            when (val click = heard(Channels.BROWSE_CLICK, carried)) {
                is Delivered -> focus(click.payload.annotationId)
                is FrameRefusal -> Unit
            }
        }
    }

    /** Stop attending: what is hovered ends, and nothing heard after moves it. */
    override fun close() {
        closed = true
        tasks.stop()
        hovered.end()
    }
}
