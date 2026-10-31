package semiont

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.extension
import kotlin.io.path.readText

/** What the repository states beside this SDK: the spec, and the corpora every SDK is run against. */
internal object Spec {
    val src: Path = Path.of("../../../specs/src")
    val conformance: Path = Path.of("../../../tests/conformance")

    fun read(path: String): JsonElement = Json.parseToJsonElement(src.resolve(path).readText())

    /** The JSON files under `directory`, in order. */
    fun jsonFiles(directory: Path): List<Path> =
        Files.walk(directory).use { files -> files.filter { it.extension == "json" }.sorted().toList() }
}

/**
 * Whether two JSON values are the same value: numbers by what they are, so a
 * `number` read as `72` and written as `72.0` is the same, and everything else
 * as it is written, a text never the same as a number that spells it.
 */
internal fun sameJson(a: JsonElement, b: JsonElement): Boolean = when {
    a is JsonObject && b is JsonObject -> a.keys == b.keys && a.keys.all { sameJson(a.getValue(it), b.getValue(it)) }
    a is JsonArray && b is JsonArray -> a.size == b.size && a.indices.all { sameJson(a[it], b[it]) }
    a is JsonNull || b is JsonNull -> a == b
    a is JsonPrimitive && b is JsonPrimitive && !a.isString && !b.isString && a.content.toBigDecimalOrNull() != null ->
        a.content.toBigDecimal().compareTo(b.content.toBigDecimalOrNull() ?: return false) == 0
    else -> a == b
}
