package semiont.bus

import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import semiont.channels.Empty
import semiont.channels.Response
import semiont.types.wireJson
import java.util.concurrent.ConcurrentHashMap

/*
 * The first fault of a value as one of the protocol's shapes. Every SDK holds
 * what it reads to the table of what each component schema requires
 * (REQUIRED_SCHEMAS, which the generator writes from the SDK's copy of it,
 * src/codegen/required-schemas.json, by the rules of
 * packages/codegen/schemas/required-shapes.mjs) before it decodes it, and
 * names the first fault it finds the same way: a member the value lacks, or
 * one of a kind its schema does not allow. What the decoder refuses that the
 * table does not state is a fault of the value itself.
 */

/** What a value must be: packages/codegen/schemas/required-shapes.mjs states what each part means. */
@Serializable
internal data class Shape(
    val ref: String? = null,
    val kinds: List<String>? = null,
    val required: List<String>? = null,
    val members: Map<String, Shape>? = null,
    val items: Shape? = null,
    val values: Shape? = null,
    val oneOf: List<Shape>? = null,
    val discriminator: Discriminator? = null,
    val allOf: List<Shape>? = null,
)

/** The member whose value names the variant a union is. */
@Serializable
internal data class Discriminator(val property: String, val mapping: Map<String, Int>)

/**
 * The first thing wrong with a value: the way to the member it is at (the
 * names of the members it is within, and its own, joined by dots; empty for
 * the value itself), and why.
 */
internal data class Fault(val member: String, val reason: FrameRefusalReason) {
    /** What every SDK says of the fault. */
    override fun toString(): String = when {
        reason == FrameRefusalReason.Lacks -> "it has no `$member`"
        member.isEmpty() -> "it is malformed"
        else -> "its `$member` is malformed"
    }
}

/** The fault of a value its decoder refuses that has no fault the table states: the value itself is malformed. */
internal val UNDECODED: Fault = Fault("", FrameRefusalReason.Malformed)

/** Each component's shape, read from the table as it is first asked for. */
private val schemas = ConcurrentHashMap<String, Shape>()

private fun schema(name: String): Shape = schemas.getOrPut(name) {
    wireJson.decodeFromString(Shape.serializer(), REQUIRED_SCHEMAS[name] ?: error("$name is no component schema of the spec"))
}

private val RESPONSE: String = Response.serializer(JsonElement.serializer()).descriptor.serialName
private val EMPTY: String = Empty.serializer().descriptor.serialName
private const val TYPES = "semiont.types."

/** What a value of `descriptor`'s type must be: a type of `semiont.types`, `Response` of one, or `Empty`. */
private fun shapeOf(descriptor: SerialDescriptor): Shape = when (val named = descriptor.serialName) {
    RESPONSE -> Shape(kinds = listOf("object"), required = listOf("response"), members = mapOf("response" to shapeOf(descriptor.getElementDescriptor(0))))
    EMPTY -> Shape(kinds = listOf("object"))
    else -> {
        require(named.startsWith(TYPES) && named.removePrefix(TYPES) in REQUIRED_SCHEMAS) { "$named is no component schema of the spec" }
        Shape(ref = named.removePrefix(TYPES))
    }
}

private tailrec fun resolved(shape: Shape): Shape = if (shape.ref == null) shape else resolved(schema(shape.ref))

/** Whether `kinds` allow `value`: none allow any, and an integer is a number with no fractional part. */
private fun allows(kinds: List<String>?, value: JsonElement): Boolean = kinds == null || when (value) {
    JsonNull -> "null" in kinds
    is JsonObject -> "object" in kinds
    is JsonArray -> "array" in kinds
    is JsonPrimitive -> when {
        value.isString -> "string" in kinds
        value.booleanOrNull != null -> "boolean" in kinds
        else -> "number" in kinds || ("integer" in kinds && value.content.toBigDecimal().stripTrailingZeros().scale() <= 0)
    }
}

private fun within(way: String, name: String): String = if (way.isEmpty()) name else "$way.$name"

/** The first fault `value` has as a value of `shape`, from `way`. */
private fun faultAt(shape: Shape, value: JsonElement, way: String): Fault? {
    val own = resolved(shape)
    if (!allows(own.kinds, value)) return Fault(way, FrameRefusalReason.Malformed)
    if (value is JsonObject) faultOfMembers(own, value, way)?.let { return it }
    if (value is JsonArray && own.items != null) value.firstNotNullOfOrNull { faultAt(own.items, it, way) }?.let { return it }
    if (own.oneOf != null) faultOfOneOf(own, own.oneOf, value, way)?.let { return it }
    return own.allOf?.firstNotNullOfOrNull { faultAt(it, value, way) }
}

/** The first fault of an object in the members `shape` requires, in what its members are, and in its values. */
private fun faultOfMembers(shape: Shape, value: JsonObject, way: String): Fault? {
    val members = shape.members.orEmpty()
    for (name in shape.required.orEmpty()) {
        val held = value[name]
        val member = members[name]
        if (held == null || (held == JsonNull && member != null && !allows(resolved(member).kinds, JsonNull))) return Fault(within(way, name), FrameRefusalReason.Lacks)
    }
    for ((name, member) in members) {
        val held = value[name]
        if (held == null || held == JsonNull) continue
        faultAt(member, held, within(way, name))?.let { return it }
    }
    return shape.values?.let { values -> value.keys.sorted().firstNotNullOfOrNull { faultAt(values, value.getValue(it), way) } }
}

/**
 * The fault `value` has as one of `variants`: the variant its discriminator
 * names, or else each variant whose kinds allow it. None when one of them has
 * none; the first one's when each has one; and a value no variant allows is
 * malformed.
 */
private fun faultOfOneOf(shape: Shape, variants: List<Shape>, value: JsonElement, way: String): Fault? {
    val named = shape.discriminator?.let { discriminator ->
        ((value as? JsonObject)?.get(discriminator.property) as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { discriminator.mapping[it] }
    }
    val candidates = named?.let { listOf(variants[it]) } ?: variants.filter { allows(resolved(it).kinds, value) }
    if (candidates.isEmpty()) return Fault(way, FrameRefusalReason.Malformed)
    var first: Fault? = null
    for (candidate in candidates) {
        val fault = faultAt(candidate, value, way) ?: return null
        if (first == null) first = fault
    }
    return first
}

/** The first fault `value` has as a value of `descriptor`'s type, by the rules every SDK reads the table by; null when it has none. */
internal fun faultOf(descriptor: SerialDescriptor, value: JsonElement): Fault? = faultAt(shapeOf(descriptor), value, "")

/** The first fault of the JSON `text` as a value of `descriptor`'s type: a text that is no JSON is malformed. */
internal fun faultIn(descriptor: SerialDescriptor, text: String): Fault? {
    val value = try {
        wireJson.parseToJsonElement(text)
    } catch (_: SerializationException) {
        return UNDECODED
    }
    return faultOf(descriptor, value)
}
