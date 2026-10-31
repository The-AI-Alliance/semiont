package semiont.state

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlin.coroutines.CoroutineContext

/**
 * What a state unit has running: its listening, and each operation it
 * started, in `context`, under the job `context` has when it has one. Stopped
 * when the unit is closed, after which nothing more is started.
 */
internal class Tasks(context: CoroutineContext) {
    private val scope = CoroutineScope(context + SupervisorJob(context[Job]))

    /** Run `work` as one of the unit's tasks. Once stopped, it never starts. */
    fun run(work: suspend CoroutineScope.() -> Unit): Job = scope.launch(block = work)

    /** Cancel everything running, and start nothing more. Stopping twice is stopping once. */
    fun stop(): Unit = scope.cancel()
}
