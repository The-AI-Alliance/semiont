package semiont.types

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/**
 * How the SDK reads and writes the protocol. A property left out stays left
 * out (no defaults are written), a null stays null, and a property an object
 * does not name is refused by an object whose schema admits none and ignored
 * by the rest, which the generator marks to ignore what a later gateway adds.
 */
internal val wireJson: Json = Json { encodeDefaults = false }

/** The first of a union's members, in the order the schema lists them, that `element` decodes as. */
internal fun <T> firstThatFits(element: JsonElement, members: List<DeserializationStrategy<T>>, union: String): DeserializationStrategy<T> =
    members.firstOrNull { runCatching { wireJson.decodeFromJsonElement(it, element) }.isSuccess }
        ?: throw SerializationException("no member of $union fits $element")
