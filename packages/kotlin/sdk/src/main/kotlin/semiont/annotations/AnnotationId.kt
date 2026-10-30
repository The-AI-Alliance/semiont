package semiont.annotations

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import semiont.identifiers.AnnotationId
import semiont.identifiers.ResourceId
import semiont.types.Motivation
import java.math.BigDecimal
import java.security.MessageDigest
import java.util.Base64

/*
 * The id of an annotation a builder makes (specs/src/annotations/id-cases.json).
 * It is not minted: it is worked out from what the annotation is, so the same
 * annotation built again, by any worker in any language, has the same id, and
 * writing it a second time changes nothing.
 */

/** How many characters of the digest's base64url an id is. */
private const val LENGTH = 21

/** Two names by their code points: what canonical JSON orders an object's members by. */
private val BY_CODE_POINT: Comparator<String> = Comparator { one, other ->
    val a = codePointsOf(one)
    val b = codePointsOf(other)
    for (at in 0 until minOf(a.size, b.size)) if (a[at] != b[at]) return@Comparator a[at].compareTo(b[at])
    a.size.compareTo(b.size)
}

/**
 * `value` as canonical JSON: no white space, and an object's members in the
 * order of their names by code point, at every depth. A string is written with
 * the escapes JSON requires and no other; a number is written as the whole
 * number it is, and one that is not whole is refused, since the rule states
 * how no other is written.
 */
private fun canonical(value: JsonElement): String = when (value) {
    is JsonNull -> "null"
    is JsonObject -> value.keys.sortedWith(BY_CODE_POINT).joinToString(",", "{", "}") { "${JsonPrimitive(it)}:${canonical(value.getValue(it))}" }
    is JsonArray -> value.joinToString(",", "[", "]") { canonical(it) }
    is JsonPrimitive -> when {
        value.isString -> value.toString()
        value.content == "true" || value.content == "false" -> value.content
        else -> {
            val number = BigDecimal(value.content)
            require(number.stripTrailingZeros().scale() <= 0) {
                "${value.content} is not a whole number, and the rule of an annotation's id states how no other is written"
            }
            number.toBigIntegerExact().toString()
        }
    }
}

/**
 * The id of the annotation of `resourceId` that has this motivation, this
 * anchor and this body. `anchor` says where on the resource the annotation is,
 * and is empty for an annotation of the resource as a whole. `body` is the body
 * as the wire carries it, and none for an annotation that has none: an
 * annotation's body is never `null`.
 */
internal fun annotationIdFor(resourceId: ResourceId, motivation: Motivation, anchor: String, body: JsonElement?): AnnotationId {
    val identity = buildMap {
        put("resourceId", JsonPrimitive(resourceId.value))
        put("motivation", JsonPrimitive(motivation.value))
        put("anchor", JsonPrimitive(anchor))
        if (body != null) put("body", body)
    }
    val digest = MessageDigest.getInstance("SHA-256").digest(canonical(JsonObject(identity)).toByteArray(Charsets.UTF_8))
    return AnnotationId(Base64.getUrlEncoder().encodeToString(digest).take(LENGTH))
}
