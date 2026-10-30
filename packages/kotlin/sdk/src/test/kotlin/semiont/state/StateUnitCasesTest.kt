package semiont.state

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import semiont.Spec
import semiont.sameJson
import semiont.session.KbIdentityConflict
import semiont.session.SessionEndReason
import semiont.session.SessionSignals

/** One unit a case made: what its members hold now, its members called, its end, and whether a member's readers have ended. */
private interface Made {
    fun read(member: String): JsonElement

    fun invoke(member: String, args: JsonObject)

    fun dispose()

    fun reader(member: String): Flow<*>
}

private class Signals : Made {
    private val signals = SessionSignals()

    override fun read(member: String): JsonElement = when (member) {
        "sessionEnded" -> signals.sessionEnded.value?.let { buildJsonObject { put("reason", it.reason.wire) } }
        "permissionDenied" -> signals.permissionDenied.value?.let { buildJsonObject { put("detail", it.detail) } }
        "kbIdentityConflict" -> signals.kbIdentityConflict.value?.let {
            buildJsonObject {
                put("expectedDid", it.expectedDid)
                put("observedDid", it.observedDid)
            }
        }
        else -> error("the sessionSignals unit has no member $member")
    } ?: JsonNull

    override fun invoke(member: String, args: JsonObject) = when (member) {
        "notifySessionEnded" -> signals.notifySessionEnded(SessionEndReason.entries.single { it.wire == args.getValue("reason").jsonPrimitive.content })
        "notifyPermissionDenied" -> signals.notifyPermissionDenied(args.getValue("detail").jsonPrimitive.contentOrNull)
        "notifyKbIdentityConflict" -> args.getValue("conflict").jsonObject.let {
            signals.notifyKbIdentityConflict(KbIdentityConflict(it.getValue("expectedDid").jsonPrimitive.content, it.getValue("observedDid").jsonPrimitive.content))
        }
        "acknowledgeSessionEnded" -> signals.acknowledgeSessionEnded()
        "acknowledgePermissionDenied" -> signals.acknowledgePermissionDenied()
        "acknowledgeKbIdentityConflict" -> signals.acknowledgeKbIdentityConflict()
        else -> error("the sessionSignals unit has no member $member")
    }

    override fun dispose() = signals.close()

    override fun reader(member: String): Flow<*> = when (member) {
        "sessionEnded" -> signals.sessionEnded
        "permissionDenied" -> signals.permissionDenied
        "kbIdentityConflict" -> signals.kbIdentityConflict
        else -> error("the sessionSignals unit has no member $member")
    }
}

/** The units Kotlin has, by the name the table gives each, and how each is made from what a case says. */
private val UNITS: Map<String, (JsonObject) -> Made> = mapOf(
    "sessionSignals" to { _ -> Signals() },
)

/**
 * specs/src/client/state-units.json, run against Kotlin's units: each case of
 * a unit Kotlin has, step by step, as the table's `$comment` reads them.
 */
class StateUnitCasesTest {
    @TestFactory
    fun eachCaseOfAUnitKotlinHasDoesWhatItSays(): List<DynamicTest> =
        Spec.read("client/state-units.json").jsonObject.getValue("cases").jsonArray.map { it.jsonObject }
            .filter { it.getValue("unit").jsonPrimitive.content in UNITS }
            .map { case -> DynamicTest.dynamicTest("${case.getValue("unit").jsonPrimitive.content}: ${case.getValue("case").jsonPrimitive.content}") { ran(case) } }

    private fun ran(case: JsonObject) = runBlocking {
        val unit = case.getValue("unit").jsonPrimitive.content
        val made = case.getValue("made").jsonObject.mapValues { (_, from) -> UNITS.getValue(unit)(from.jsonObject) }
        for (step in case.getValue("steps").jsonArray.map { it.jsonObject }) {
            val (form, said) = step.entries.first { it.key != "of" && it.key != "args" }
            when (form) {
                "invoke" -> made.getValue(step.getValue("of").jsonPrimitive.content).invoke(said.jsonPrimitive.content, step["args"]?.jsonObject ?: JsonObject(emptyMap()))
                "dispose" -> made.getValue(said.jsonPrimitive.content).dispose()
                "expect" -> for ((name, members) in said.jsonObject) {
                    for ((member, expected) in members.jsonObject) {
                        val held = made.getValue(name).read(member)
                        assertTrue(sameJson(expected, held), "$name.$member holds $held, not $expected")
                    }
                }
                "ended" -> for ((name, members) in said.jsonObject) {
                    for (member in members.jsonArray.map { it.jsonPrimitive.content }) {
                        val ended = withTimeoutOrNull(1_000) { made.getValue(name).reader(member).collect() } != null
                        assertTrue(ended, "$name.$member's readers have not ended")
                    }
                }
                else -> error("a step of the form $form, which this runner does not read")
            }
        }
    }
}
