@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.state

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import semiont.StateUnit
import semiont.identifiers.AnnotationId
import kotlin.coroutines.CoroutineContext

/**
 * A pointer's dwell: an annotation is hovered once the pointer has rested on
 * it for `delayMs`, and no longer the moment it leaves. A pointer crossing the
 * page hovers nothing on its way. `say` is told each change: the annotation
 * hovered, or none. `client.beckon.hover` is what it is usually given, and
 * `Timings.HOVER_DELAY_MS` the delay, unless the viewer was told another.
 * Closing it forgets a rest that has not run its time, and it says nothing
 * more. Its rest is timed in `context`.
 */
public class HoverDwell internal constructor(
    private val say: (AnnotationId?) -> Unit,
    private val delayMs: Long,
    context: CoroutineContext,
) : StateUnit {
    /** A dwell whose rest is timed on the default dispatcher. */
    public constructor(say: (AnnotationId?) -> Unit, delayMs: Long) : this(say, delayMs, Dispatchers.Default)

    private val tasks = Tasks(context)

    /** What was last said to be hovered. */
    private var hovering: AnnotationId? = null

    /** The rest that has not run its time yet, and which rest it is: a rest that is no longer the latest says nothing. */
    private var resting: Job? = null
    private var rests = 0
    private var closed = false

    /** The pointer is on an annotation: hovered once the pointer has stayed for the delay. One already hovered is not said again. */
    @JvmExposeBoxed
    public fun enter(annotationId: AnnotationId): Unit = synchronized(this) {
        if (closed || hovering == annotationId) return
        resting?.cancel()
        val rest = ++rests
        resting = tasks.run {
            delay(delayMs)
            rested(annotationId, rest)
        }
    }

    private fun rested(annotationId: AnnotationId, rest: Int) {
        synchronized(this) {
            if (closed || rest != rests) return
            resting = null
            hovering = annotationId
        }
        say(annotationId)
    }

    /** The pointer left. Said at once, and only when something was hovered. */
    public fun leave() {
        synchronized(this) {
            if (closed) return
            resting?.cancel()
            resting = null
            rests++
            if (hovering == null) return
            hovering = null
        }
        say(null)
    }

    override fun close(): Unit = synchronized(this) {
        closed = true
        tasks.stop()
    }
}
