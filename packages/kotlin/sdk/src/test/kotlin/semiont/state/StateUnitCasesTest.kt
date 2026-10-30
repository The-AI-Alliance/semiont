package semiont.state

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import org.junit.jupiter.api.assertThrows
import semiont.ClientTiming
import semiont.Recording
import semiont.SemiontClient
import semiont.Spec
import semiont.StateUnit
import semiont.Timings
import semiont.errors.SemiontError
import semiont.identifiers.AnnotationId
import semiont.identifiers.ResourceId
import semiont.sameJson
import semiont.session.KbIdentityConflict
import semiont.session.SessionEndReason
import semiont.session.SessionSignals
import semiont.transport.Frame
import semiont.transport.Watched
import semiont.types.wireJson
import kotlin.coroutines.CoroutineContext

private val TABLE: JsonObject = Spec.read("client/state-units.json").jsonObject
private val NAMES: JsonObject = Spec.read("client/surface.json").jsonObject

private fun JsonElement.text(): String = jsonPrimitive.content

/** `value` with each `{"$fixture": name}` replaced by the table's fixture. */
private fun resolved(value: JsonElement): JsonElement = when (value) {
    is JsonArray -> JsonArray(value.map(::resolved))
    is JsonObject ->
        if (value.keys == setOf("\$fixture")) {
            val name = value.getValue("\$fixture").text()
            resolved(TABLE.getValue("fixtures").jsonObject[name] ?: error("the table has no fixture $name"))
        } else {
            JsonObject(value.mapValues { (_, item) -> resolved(item) })
        }
    else -> value
}

/** A duration as the table states it, in milliseconds: a number, or a timing of specs/src/client/timing.json, scaled and moved. */
private fun durationMs(value: JsonElement): Long {
    if (value is JsonPrimitive) return value.content.toLong()
    val stated = value.jsonObject
    val name = stated.getValue("timing").text().replace(Regex("(?<=[a-z])(?=[A-Z])"), "_").uppercase()
    val base = Timings::class.java.getField(name).getLong(null)
    val times = stated["times"]?.jsonPrimitive?.doubleOrNull ?: 1.0
    val plus = stated["plusMs"]?.jsonPrimitive?.content?.toLong() ?: 0
    return Math.round(base * times) + plus
}

/** Whether `actual` is what `expected` states: exactly, but where `$has` asks only for some members. */
private fun matches(expected: JsonElement, actual: JsonElement): Boolean = when {
    expected is JsonObject && expected.keys == setOf("\$has") ->
        actual is JsonObject && expected.getValue("\$has").jsonObject.all { (key, value) -> actual[key]?.let { matches(value, it) } == true }
    expected is JsonObject -> actual is JsonObject && expected.keys == actual.keys && expected.all { (key, value) -> matches(value, actual.getValue(key)) }
    expected is JsonArray -> actual is JsonArray && expected.size == actual.size && expected.indices.all { matches(expected[it], actual[it]) }
    else -> sameJson(expected, actual)
}

/** What a state holds, as a case states it: a value as the wire writes it, or an error, compared on what the case states of it. */
internal sealed interface Held {
    data class Wire(val value: JsonElement) : Held

    data class Failure(val code: String, val message: String) : Held
}

private fun holds(expected: JsonElement, held: Held): Boolean = when (held) {
    is Held.Wire -> matches(resolved(expected), held.value)
    is Held.Failure -> expected is JsonObject && expected.all { (key, value) ->
        when (key) {
            "code" -> value.text() == held.code
            "message" -> value.text() == held.message
            else -> false
        }
    }
}

private fun written(held: Held): JsonElement = when (held) {
    is Held.Wire -> held.value
    is Held.Failure -> JsonObject(mapOf("code" to JsonPrimitive(held.code), "message" to JsonPrimitive(held.message)))
}

/** One state of a unit: what it holds now, as a case states it, and its readers. */
internal class State<T>(private val watched: Watched<T>, private val written: (T) -> Held) {
    fun now(): Held = written(watched.value)

    fun reader(): Flow<T> = watched
}

/** A state holding a value the wire writes, or none. */
internal inline fun <reified T> wire(watched: Watched<T?>): State<T?> =
    State(watched) { held -> Held.Wire(if (held == null) JsonNull else wireJson.encodeToJsonElement(serializer<T>(), held)) }

/** A state holding a failure, or none. */
internal fun failure(watched: Watched<SemiontError?>): State<SemiontError?> =
    State(watched) { held -> if (held == null) Held.Wire(JsonNull) else Held.Failure(held.code, held.message ?: "") }

/** One unit a case made: its states by member, its methods by member, and its end. */
internal class Made(private val unit: StateUnit, private val states: Map<String, State<*>>, private val methods: Map<String, (JsonObject) -> Unit>) {
    fun read(member: String): Held = (states[member] ?: error("the unit has no state $member")).now()

    fun reader(member: String): Flow<*> = (states[member] ?: error("the unit has no state $member")).reader()

    fun invoke(member: String, args: JsonObject): Unit = (methods[member] ?: error("the unit has no method $member"))(args)

    fun dispose(): Unit = unit.close()
}

/**
 * What a case's search pipeline searches with: it records each query it is
 * asked, and gives each the answers a step gives it, none while one is on its
 * way. A query abandoned has nobody to give its answers to.
 */
internal class Searches {
    val asked = mutableListOf<Pair<String, Channel<List<String>?>>>()

    fun search(query: String): Flow<List<String>?> {
        val answers = Channel<List<String>?>(Channel.UNLIMITED)
        asked += query to answers
        return flow { for (answer in answers) emit(answer) }
    }

    fun answer(nth: Int, results: List<String>?) {
        assertTrue(asked.size > nth, "query #$nth was not asked")
        asked[nth].second.trySend(results)
    }
}

/** What a unit is made over: the case's client, its search, and its clock. */
internal class Over(val client: SemiontClient, val searches: Searches, val clock: CoroutineContext)

private fun Over.match(): Made = Made(MatchStateUnit(client), emptyMap(), emptyMap())

private fun Over.beckon(made: JsonObject): Made {
    val unit = BeckonStateUnit(client, ResourceId(made.getValue("resourceId").text()))
    return Made(
        unit,
        mapOf("hoveredAnnotationId" to wire(unit.hoveredAnnotationId)),
        mapOf("focus" to { args -> unit.focus(AnnotationId(args.getValue("annotationId").text())) }),
    )
}

private fun Over.hoverDwell(made: JsonObject): Made {
    val unit = HoverDwell(client.beckon::hover, durationMs(made.getValue("delayMs")), clock)
    return Made(
        unit,
        emptyMap(),
        mapOf(
            "enter" to { args -> unit.enter(AnnotationId(args.getValue("annotationId").text())) },
            "leave" to { _ -> unit.leave() },
        ),
    )
}

private fun Over.search(made: JsonObject): Made {
    val unit = SearchPipeline(
        searches::search,
        made["debounceMs"]?.let(::durationMs) ?: Timings.SEARCH_DEBOUNCE_MS,
        made["initialQuery"]?.text() ?: "",
        clock,
    )
    return Made(
        unit,
        mapOf(
            "query" to State(unit.query) { Held.Wire(JsonPrimitive(it)) },
            "state" to State(unit.state) {
                Held.Wire(JsonObject(mapOf("results" to JsonArray(it.results.map(::JsonPrimitive)), "isSearching" to JsonPrimitive(it.isSearching))))
            },
        ),
        mapOf("setQuery" to { args -> unit.setQuery(args.getValue("value").text()) }),
    )
}

private fun signals(): Made {
    val signals = SessionSignals()
    return Made(
        signals,
        mapOf(
            "sessionEnded" to State(signals.sessionEnded) { held -> Held.Wire(held?.let { JsonObject(mapOf("reason" to JsonPrimitive(it.reason.wire))) } ?: JsonNull) },
            "permissionDenied" to State(signals.permissionDenied) { held -> Held.Wire(held?.let { JsonObject(mapOf("detail" to JsonPrimitive(it.detail))) } ?: JsonNull) },
            "kbIdentityConflict" to State(signals.kbIdentityConflict) { held ->
                Held.Wire(held?.let { JsonObject(mapOf("expectedDid" to JsonPrimitive(it.expectedDid), "observedDid" to JsonPrimitive(it.observedDid))) } ?: JsonNull)
            },
        ),
        mapOf(
            "notifySessionEnded" to { args -> signals.notifySessionEnded(SessionEndReason.entries.single { it.wire == args.getValue("reason").text() }) },
            "notifyPermissionDenied" to { args -> signals.notifyPermissionDenied(args.getValue("detail").jsonPrimitive.contentOrNull) },
            "notifyKbIdentityConflict" to { args ->
                val conflict = args.getValue("conflict").jsonObject
                signals.notifyKbIdentityConflict(KbIdentityConflict(conflict.getValue("expectedDid").text(), conflict.getValue("observedDid").text()))
            },
            "acknowledgeSessionEnded" to { _ -> signals.acknowledgeSessionEnded() },
            "acknowledgePermissionDenied" to { _ -> signals.acknowledgePermissionDenied() },
            "acknowledgeKbIdentityConflict" to { _ -> signals.acknowledgeKbIdentityConflict() },
        ),
    )
}

/** How Kotlin makes each unit it has, by the name the table gives it, from what the case makes it from. */
private val MAKERS: Map<String, Over.(JsonObject) -> Made> = mapOf(
    "match" to { _ -> match() },
    "beckon" to { made -> beckon(made) },
    "hoverDwell" to { made -> hoverDwell(made) },
    "search" to { made -> search(made) },
    "sessionSignals" to { _ -> signals() },
)

/** The units the names table says Kotlin has: neither absent nor yet to be reached. */
private val HAS: Set<String> = NAMES.getValue("stateUnits").jsonArray.map { it.jsonObject }
    .filter { row -> listOf("absent", "notYetReached").none { row[it]?.jsonObject?.containsKey("kotlin") == true } }
    .map { it.getValue("unit").text() }
    .toSet()

private val CASES: List<JsonObject> = TABLE.getValue("cases").jsonArray.map { it.jsonObject }
private val RUN: List<JsonObject> = CASES.filter { it.getValue("unit").text() in HAS }

private fun answersOf(stated: String): Answers = Answers.entries.single { it.name.lowercase() == stated }

/** A case, played step by step on a clock only its steps move. */
private fun play(case: JsonObject) = runTest {
    val clock = StandardTestDispatcher(testScheduler)
    val stated = case.getValue("transport").jsonObject
    val transport = Answering(answersOf(stated.getValue("answers").text()), stated["delayMs"]?.let(::durationMs), clock)
    for ((operation, responses) in stated["replies"]?.jsonObject ?: JsonObject(emptyMap())) {
        for (response in responses.jsonArray) transport.queueReply(operation, resolved(response).takeUnless { it is JsonNull })
    }
    val gateway = Recording()
    val client = SemiontClient(transport, gateway, gateway, ClientTiming(), null, clock)
    val searches = Searches()
    val over = Over(client, searches, clock)
    val maker = MAKERS.getValue(case.getValue("unit").text())
    val units = case.getValue("made").jsonObject.mapValues { (_, from) -> over.maker(from.jsonObject) }
    // Taken now, before anything runs, so what is said from the moment the units are made is heard.
    val listening = case["listen"]?.jsonArray?.map { it.text() }.orEmpty()
    val heard = mutableListOf<Frame>()
    if (listening.isNotEmpty()) {
        val frames = client.bus.framesAmong(listening)
        backgroundScope.launch(clock) { frames.collect { heard += it } }
    }
    val steps = Steps(transport, client, searches, units, heard)
    try {
        for ((at, step) in case.getValue("steps").jsonArray.withIndex()) {
            try {
                steps.perform(this, step)
            } catch (broken: AssertionError) {
                throw AssertionError("steps[$at] $step: ${broken.message}", broken)
            }
        }
    } finally {
        units.values.forEach { it.dispose() }
        client.close()
        transport.close()
        runCurrent()
    }
}

private class Steps(
    private val transport: Answering,
    private val client: SemiontClient,
    private val searches: Searches,
    private val units: Map<String, Made>,
    private val heard: List<Frame>,
) {
    /** How much of what was heard has been checked. */
    private var told = 0

    private fun unit(name: JsonElement): Made = units[name.text()] ?: error("the case made no unit ${name.text()}")

    /** The correlation id the `nth` request sent on `channel` carried. */
    private fun requestId(channel: String, nth: Int): String? {
        val sent = transport.requestLog.filter { it.channel == channel }
        assertTrue(sent.size > nth, "request #$nth on $channel was not sent")
        return sent[nth].correlationId
    }

    fun perform(test: TestScope, step: JsonElement) {
        if (step is JsonPrimitive && step.content == "settle") return test.runCurrent()
        val said = step.jsonObject
        val correlationId = said["correlationId"]?.jsonPrimitive?.contentOrNull
        when {
            "say" in said -> client.bus.emit(said.getValue("say").text(), resolved(said.getValue("payload")).jsonObject, null, correlationId)
            "deliver" in said -> transport.deliver(Frame(said.getValue("deliver").text(), resolved(said.getValue("payload")).jsonObject, correlationId))
            "answer" in said -> {
                val asked = requestId(said.getValue("answer").text(), said.getValue("nth").jsonPrimitive.int)
                transport.deliver(Frame(said.getValue("reply").text(), resolved(said.getValue("payload")).jsonObject, asked))
            }
            "queueReply" in said -> transport.queueReply(said.getValue("queueReply").text(), resolved(said.getValue("response")).takeUnless { it is JsonNull })
            "invoke" in said -> unit(said.getValue("of")).invoke(said.getValue("invoke").text(), resolved(said["args"] ?: JsonObject(emptyMap())).jsonObject)
            "pass" in said -> {
                // What is ready runs at the time it became ready, before the clock moves; what falls due runs to its end.
                test.runCurrent()
                test.advanceTimeBy(durationMs(said.getValue("pass")))
                test.runCurrent()
            }
            "dispose" in said -> unit(said.getValue("dispose")).dispose()
            "answerSearch" in said -> searches.answer(said.getValue("answerSearch").jsonPrimitive.int, (said.getValue("results") as? JsonArray)?.map { it.text() })
            "searched" in said -> {
                val queries = searches.asked.map { it.first }
                assertEquals(said.getValue("searched").jsonArray.map { it.text() }, queries, "the search was asked $queries")
            }
            "expect" in said -> for ((name, members) in said.getValue("expect").jsonObject) {
                for ((member, expected) in members.jsonObject) {
                    val held = unit(JsonPrimitive(name)).read(member)
                    assertTrue(holds(expected, held), "$name.$member holds ${written(held)}, not $expected")
                }
            }
            "sent" in said -> {
                val channel = said.getValue("sent").text()
                val sent = JsonArray(transport.requestLog.filter { it.channel == channel }.map { it.payload })
                if ("count" in said) {
                    assertEquals(said.getValue("count").jsonPrimitive.int, sent.size, "${sent.size} requests were sent on $channel")
                } else {
                    assertTrue(matches(resolved(said.getValue("payloads")), sent), "sent on $channel: $sent")
                }
            }
            "nothingSent" in said -> assertEquals(emptyList<Sent>(), transport.requestLog, "requests were sent")
            "heard" in said -> {
                test.runCurrent()
                val frames = heard.drop(told)
                val wanted = said.getValue("heard").jsonArray.map { it.jsonObject }
                val got = frames.map { "${it.channel} ${it.payload} ${it.correlationId}" }
                assertEquals(wanted.size, frames.size, "heard $got")
                for ((one, frame) in wanted.zip(frames)) {
                    val stated = one["correlationId"]
                    val expectedId = when (stated) {
                        null, is JsonNull -> null
                        is JsonObject -> requestId(stated.getValue("sent").text(), stated.getValue("nth").jsonPrimitive.int)
                        else -> stated.text()
                    }
                    assertEquals(one.getValue("channel").text(), frame.channel, "heard $got")
                    assertTrue(matches(resolved(one.getValue("payload")), frame.payload), "heard $got")
                    assertEquals(expectedId, frame.correlationId, "heard $got")
                }
                told = heard.size
            }
            "ended" in said -> for ((name, members) in said.getValue("ended").jsonObject) {
                for (member in members.jsonArray.map { it.text() }) {
                    val reading = test.backgroundScope.launch { unit(JsonPrimitive(name)).reader(member).collect {} }
                    test.runCurrent()
                    val ended = reading.isCompleted
                    reading.cancel()
                    assertTrue(ended, "$name.$member has not ended")
                }
            }
            "busDestroyed" in said -> assertEquals(said.getValue("busDestroyed").jsonPrimitive.booleanOrNull, client.bus.isDestroyed, "whether the client's bus is destroyed")
            else -> error("a step this runner does not perform: $step")
        }
    }
}

/**
 * specs/src/client/state-units.json, run against Kotlin's units: each case of
 * a unit the names table says Kotlin has, step by step, as the table's
 * `$comment` reads them, on a clock only the steps move.
 */
class StateUnitCasesTest {
    @Test
    fun kotlinMakesEachUnitItHasCasesOfAndNoOther() {
        // A unit the table states no case of (the cache and the session, whose behaviour their own tables hold) needs no maker here.
        assertEquals(RUN.map { it.getValue("unit").text() }.toSet(), MAKERS.keys)
    }

    @Test
    fun everyCaseIsOfAUnitTheNamesTableHas() {
        val named = NAMES.getValue("stateUnits").jsonArray.map { it.jsonObject.getValue("unit").text() }.toSet()
        assertTrue(named.containsAll(CASES.map { it.getValue("unit").text() }))
    }

    @TestFactory
    fun aUnitDoesWhatItsCaseSays(): List<DynamicTest> =
        RUN.map { case -> DynamicTest.dynamicTest("${case.getValue("unit").text()}: ${case.getValue("case").text()}") { play(case) } }

    @Test
    fun theRunnerFailsACaseWhoseCheckIsWrong() {
        val case = RUN.first { it.getValue("unit").text() == "match" }
        val told = JsonObject(
            case + ("steps" to JsonArray(case.getValue("steps").jsonArray.map { step -> if (step is JsonObject && "heard" in step) JsonObject(step + ("heard" to JsonArray(emptyList()))) else step })),
        )
        val broken = assertThrows<AssertionError> { play(told) }
        assertTrue(broken.message!!.contains("heard"), broken.message)
    }
}
