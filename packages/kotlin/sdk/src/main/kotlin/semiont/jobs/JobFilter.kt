package semiont.jobs

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Whether `actual` states everything `stated` does, at the same paths: an object by the members `stated` has, anything else as the value it is. */
private fun states(stated: JsonElement, actual: JsonElement): Boolean = when (stated) {
    is JsonObject -> actual is JsonObject && stated.all { (name, value) -> actual[name]?.let { states(value, it) } == true }
    else -> same(stated, actual)
}

/** Whether two values are one value. A number is the number it is, however it was written: 1 and 1.0 are one, and neither is `true` or "1". */
private fun same(one: JsonElement, other: JsonElement): Boolean = when {
    one is JsonObject || other is JsonObject -> one is JsonObject && other is JsonObject && one.keys == other.keys && one.all { (name, value) -> same(value, other.getValue(name)) }
    one is JsonArray || other is JsonArray -> one is JsonArray && other is JsonArray && one.size == other.size && one.indices.all { same(one[it], other[it]) }
    one is JsonNull || other is JsonNull -> one is JsonNull && other is JsonNull
    one is JsonPrimitive && other is JsonPrimitive -> when {
        one.isString || other.isString -> one.isString && other.isString && one.content == other.content
        else -> {
            val first = one.content.toBigDecimalOrNull()
            val second = other.content.toBigDecimalOrNull()
            // Neither a number: both are `true` or `false`.
            if (first == null || second == null) first == null && second == null && one.content == other.content else first.compareTo(second) == 0
        }
    }
    else -> false
}

/**
 * Whether `job` matches `filter`: every field the filter states equals the
 * job's at the same path, and what it leaves out is not compared. So the
 * comparison knows no field by name. Both are as the wire carries them: a
 * filter as a claim states it, a job's description as it is announced or
 * held, with its `jobType` and its `params`. The dispatcher asks it to choose
 * a claim's next job, and a worker asks it of an announcement before it
 * claims; specs/src/jobs/filter-cases.json is the table both answer alike.
 */
public fun jobMatchesFilter(filter: JsonObject, job: JsonObject): Boolean = states(filter, job)
