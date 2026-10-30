@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package semiont.state

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.StateUnit
import semiont.cache.Cache
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode
import semiont.identifiers.AnnotationId
import semiont.identifiers.ResourceId
import semiont.session.KbIdentityConflict
import semiont.session.SemiontSession
import semiont.session.SessionEndReason
import semiont.session.SessionSignals
import semiont.session.TARGET
import semiont.signin.MemorySignIn
import semiont.types.GatheredContext
import semiont.types.GenerationJobParams
import semiont.types.HighlightingJobParams
import semiont.types.wireJson
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.extension
import kotlin.io.path.readText

private val ANNOTATION = AnnotationId("ann-1")
private val RESOURCE = ResourceId("res-1")

private val GENERATION = GenerationJobParams(
    title = "A title",
    storageUri = "file://generated.md",
    context = wireJson.decodeFromString(
        GatheredContext.serializer(),
        """{"focus": {"kind": "resource", "resource": {"@context": "https://schema.org", "@id": "res-1", "name": "A resource", "representations": []}}, "graph": {"nodes": [], "edges": []}, "metadata": {}}""",
    ),
)

private object Signals : AxiomSubject<SessionSignals>() {
    override fun setup(bench: Bench): Fresh<SessionSignals> = Fresh(SessionSignals())

    override fun surfaces(unit: SessionSignals): List<Flow<*>> = listOf(unit.sessionEnded, unit.permissionDenied, unit.kbIdentityConflict)

    override fun invocations(unit: SessionSignals): List<() -> Unit> = listOf(
        { unit.notifySessionEnded(SessionEndReason.REFUSED) },
        { unit.notifyPermissionDenied("no") },
        { unit.notifyKbIdentityConflict(KbIdentityConflict("did:web:kb.example.org", "did:web:other.example.org")) },
        unit::acknowledgeSessionEnded,
        unit::acknowledgePermissionDenied,
        unit::acknowledgeKbIdentityConflict,
    )
}

private object Matches : AxiomSubject<MatchStateUnit>() {
    override fun setup(bench: Bench): Fresh<MatchStateUnit> {
        val client = bench.client()
        return Fresh(MatchStateUnit(client)).given(client)
    }
}

private object Beckons : AxiomSubject<BeckonStateUnit>() {
    override fun setup(bench: Bench): Fresh<BeckonStateUnit> {
        val client = bench.client()
        return Fresh(BeckonStateUnit(client, RESOURCE)).given(client)
    }

    override fun surfaces(unit: BeckonStateUnit): List<Flow<*>> = listOf(unit.hoveredAnnotationId)

    override fun invocations(unit: BeckonStateUnit): List<() -> Unit> = listOf({ unit.focus(ANNOTATION) })
}

private object Dwells : AxiomSubject<HoverDwell>() {
    override fun setup(bench: Bench): Fresh<HoverDwell> = Fresh(HoverDwell({}, 150, bench.context))

    override fun invocations(unit: HoverDwell): List<() -> Unit> = listOf({ unit.enter(ANNOTATION) }, unit::leave)
}

private object Pipelines : AxiomSubject<SearchPipeline<String>>() {
    override fun setup(bench: Bench): Fresh<SearchPipeline<String>> = Fresh(SearchPipeline({ _: String -> emptyFlow() }, 250, "", bench.context))

    override fun surfaces(unit: SearchPipeline<String>): List<Flow<*>> = listOf(unit.query, unit.state)

    override fun invocations(unit: SearchPipeline<String>): List<() -> Unit> = listOf({ unit.setQuery("paris") }, { unit.setQuery(" ") })
}

private object Gathers : AxiomSubject<GatherStateUnit>() {
    override fun setup(bench: Bench): Fresh<GatherStateUnit> {
        val client = bench.client()
        return Fresh(GatherStateUnit(client, RESOURCE)).given(client)
    }

    override fun surfaces(unit: GatherStateUnit): List<Flow<*>> =
        listOf(unit.context, unit.loading, unit.error, unit.annotationId, unit.resourceContext, unit.resourceLoading, unit.resourceError)

    override fun invocations(unit: GatherStateUnit): List<() -> Unit> = listOf({ unit.gatherAnnotation(ANNOTATION) }, { unit.gatherResource(RESOURCE) })
}

private object Yields : AxiomSubject<YieldStateUnit>() {
    override fun setup(bench: Bench): Fresh<YieldStateUnit> {
        val client = bench.client()
        return Fresh(YieldStateUnit(client, "en")).given(client)
    }

    override fun surfaces(unit: YieldStateUnit): List<Flow<*>> = listOf(unit.isGenerating, unit.progress, unit.outcome, unit.failure, unit.jobId)

    override fun invocations(unit: YieldStateUnit): List<() -> Unit> = listOf({ unit.generate(GENERATION) }, unit::dismissProgress)
}

private object Marks : AxiomSubject<MarkStateUnit>() {
    override fun setup(bench: Bench): Fresh<MarkStateUnit> {
        val client = bench.client()
        return Fresh(MarkStateUnit(client, RESOURCE)).given(client)
    }

    override fun surfaces(unit: MarkStateUnit): List<Flow<*>> =
        listOf(unit.pendingAnnotation, unit.delegatingMotivation, unit.progress, unit.progressMotivation, unit.failure, unit.jobId)

    override fun invocations(unit: MarkStateUnit): List<() -> Unit> = listOf({ unit.requestDelegate(HighlightingJobParams()) }, unit::cancelPending, unit::dismissProgress)
}

private object Caches : AxiomSubject<Cache<String, Int>>() {
    override fun setup(bench: Bench): Fresh<Cache<String, Int>> {
        var asked = 0
        return Fresh(Cache({ _: String -> ++asked }, CoroutineScope(bench.context)))
    }

    override fun surfaces(unit: Cache<String, Int>): List<Flow<*>> = listOf(unit.observe("a"))

    override fun invocations(unit: Cache<String, Int>): List<() -> Unit> = listOf(
        { unit.set("a", 1) },
        { unit.invalidate("a") },
        unit::invalidateAll,
        { unit.remove("a", BusRequestError(BusRequestErrorCode.NotFound, "gone")) },
    )
}

/** A session built and not started: what a started session's end stops is held by the session's own tests. */
private object Sessions : AxiomSubject<SemiontSession>() {
    override fun setup(bench: Bench): Fresh<SemiontSession> {
        val client = bench.client()
        return Fresh(SemiontSession(TARGET, client, MutableStateFlow(null), MemorySignIn(), null, null, null, null)).given(client)
    }

    // Its stream state and its errors are its client's, and end with it.
    override fun surfaces(unit: SemiontSession): List<Flow<*>> = listOf(unit.token, unit.user)
}

/** A subject for each state unit the SDK has. */
private val SUBJECTS: List<AxiomSubject<*>> = listOf(Signals, Matches, Beckons, Dwells, Pipelines, Gathers, Yields, Marks, Caches, Sessions)

/** Where the compiler put the SDK's classes. */
private val CLASSES: Path = Path.of("build/classes/kotlin/main")

/** Every class the SDK compiles that is a state unit. */
private fun declaredUnits(): Set<Class<*>> = Files.walk(CLASSES).use { files ->
    files.filter { it.extension == "class" }.toList()
}.map { Class.forName(CLASSES.relativize(it).toString().removeSuffix(".class").replace('/', '.'), false, StateUnit::class.java.classLoader) }
    .filter { StateUnit::class.java.isAssignableFrom(it) && !it.isInterface }
    .toSet()

/** The classes the subjects build. */
private fun subjectsUnits(): Set<Class<*>> {
    val units = mutableSetOf<Class<*>>()
    runTest {
        val bench = Bench(StandardTestDispatcher(testScheduler), testScheduler.timeSource)
        SUBJECTS.forEach { units += it.builds(bench) }
        bench.close()
    }
    return units
}

/**
 * Every state unit of the SDK keeps the axioms (`assertStateUnitAxioms`). The
 * census holds that every class the SDK compiles as a state unit has a subject
 * here, and that no public member of the SDK hands out what writes a state.
 */
class StateUnitAxiomsTest {
    @TestFactory
    fun eachUnitKeepsTheStateUnitAxioms(): List<DynamicTest> = SUBJECTS.map { subject -> DynamicTest.dynamicTest(checkNotNull(subject::class.simpleName)) { subject.keepsTheAxioms() } }

    @Test
    fun everyStateUnitOfTheSdkHasASubjectThatRunsTheAxiomsAgainstIt() {
        val declared = declaredUnits()
        assertTrue(SessionSignals::class.java in declared, "the census found no session signals among the SDK's classes: ${declared.map { it.simpleName }}")
        assertEquals(declared.map { it.name }.sorted(), subjectsUnits().map { it.name }.sorted())
    }

    @Test
    fun noPublicMemberHandsOutWhatWritesAState() {
        val writers = Regex("""\)L(kotlinx/coroutines/flow/Mutable(State|Shared)Flow|kotlinx/coroutines/channels/(Send)?Channel);""")
        val handing = Path.of("api/sdk.api").readText().lines().filter { writers.containsMatchIn(it) }
        assertEquals(emptyList<String>(), handing)
    }
}
