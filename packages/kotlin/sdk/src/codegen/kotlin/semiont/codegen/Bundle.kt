package semiont.codegen

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.nio.file.Path
import kotlin.io.path.nameWithoutExtension
import kotlin.io.path.readText

/** A generation that cannot be what the spec says: the build stops with why. */
internal class Refused(message: String) : RuntimeException(message)

internal fun refuse(message: String): Nothing = throw Refused(message)

internal fun readJson(path: Path): JsonElement =
    try {
        Json.parseToJsonElement(path.readText())
    } catch (error: Exception) {
        refuse("$path is not JSON: ${error.message}")
    }

/**
 * One OpenAPI document of specs/src with every file `$ref` followed: each
 * file the root document lists under `components` named by its component, a
 * file that is under `schemas/` or `responses/` named by its own name, and
 * the rest inlined, as the published bundles are.
 */
internal class Bundle private constructor() {
    /** Each file the document names as a component → (kind, name). */
    private val named = mutableMapOf<Path, Pair<String, String>>()

    /** The components, resolved, as they will be written. */
    private val components = sortedMapOf<String, MutableMap<String, JsonElement>>()

    companion object {
        fun of(rootFile: Path): JsonObject {
            val root = rootFile.toRealPath()
            val document = readJson(root) as? JsonObject ?: refuse("$root is no JSON object")
            val base = root.parent
            val bundle = Bundle()
            val declared = document["components"] as? JsonObject ?: JsonObject(emptyMap())
            for ((kind, entries) in declared) {
                for ((name, entry) in entries as? JsonObject ?: continue) {
                    val file = ((entry as? JsonObject)?.get("\$ref") as? JsonPrimitive)?.content ?: continue
                    bundle.name(base.resolve(file), kind, name)
                }
            }
            for ((kind, entries) in declared) {
                for ((name, entry) in entries as? JsonObject ?: continue) {
                    val file = ((entry as? JsonObject)?.get("\$ref") as? JsonPrimitive)?.content
                    val resolved = if (file != null) bundle.load(base.resolve(file)) else bundle.resolve(entry, base)
                    bundle.components.getOrPut(kind) { sortedMapOf() }[name] = resolved
                }
            }
            val rest = document.filterKeys { it != "components" }.mapValues { (_, value) -> bundle.resolve(value, base) }
            val components = JsonObject(bundle.components.mapValues { (_, entries) -> JsonObject(entries) })
            return JsonObject(rest + ("components" to components))
        }
    }

    private fun name(file: Path, kind: String, name: String) {
        val real = file.toRealPath()
        val already = named[real]
        if (already != null && already != kind to name) refuse("$real is named both ${already.first}/${already.second} and $kind/$name")
        named[real] = kind to name
    }

    /** A file's contents, with every `$ref` in it resolved relative to it. */
    private fun load(file: Path): JsonElement {
        val real = file.toRealPath()
        return resolve(readJson(real), real.parent)
    }

    private fun resolve(node: JsonElement, base: Path): JsonElement = when (node) {
        is JsonArray -> JsonArray(node.map { resolve(it, base) })
        is JsonObject -> {
            val reference = (node["\$ref"] as? JsonPrimitive)?.content
            if (reference == null) {
                JsonObject(node.mapValues { (_, value) -> resolve(value, base) })
            } else {
                val file = reference.substringBefore('#')
                if (file.isEmpty()) refuse("an internal \$ref $reference in a file under $base: specs/src refers by file")
                if (reference.contains('#')) refuse("\$ref $reference under $base points into a file: specs/src refers to whole files")
                val target = base.resolve(file).toRealPath()
                val component = named[target] ?: run {
                    val kind = target.parent.fileName.toString()
                    if (kind == "schemas" || kind == "responses") kind to target.nameWithoutExtension else null
                }
                if (component == null) {
                    load(target)
                } else {
                    if (target !in named) {
                        name(target, component.first, component.second)
                        components.getOrPut(component.first) { sortedMapOf() }[component.second] = load(target)
                    }
                    JsonObject(mapOf("\$ref" to JsonPrimitive("#/components/${component.first}/${component.second}")))
                }
            }
        }
        else -> node
    }
}

/**
 * The document's component schemas as JSON Schema draft 7, by name: `nullable`
 * beside a `type` adds `null` to it; beside anything else it becomes
 * `anyOf: [{type: null}, <the rest>]`.
 */
internal fun draft7Definitions(document: JsonObject): JsonObject {
    fun convert(node: JsonElement): JsonElement = when (node) {
        is JsonArray -> JsonArray(node.map(::convert))
        is JsonObject -> {
            val converted = node.mapValues { (key, value) ->
                val reference = (value as? JsonPrimitive)?.content
                if (key == "\$ref" && reference != null && reference.startsWith("#/components/schemas/")) {
                    JsonPrimitive("#/definitions/" + reference.removePrefix("#/components/schemas/"))
                } else {
                    convert(value)
                }
            }
            if (converted["nullable"] == JsonPrimitive(true)) {
                val rest = converted - "nullable"
                val type = rest["type"]
                if (type is JsonPrimitive && type.isString) {
                    JsonObject(rest + ("type" to JsonArray(listOf(type, JsonPrimitive("null")))))
                } else {
                    JsonObject(mapOf("anyOf" to JsonArray(listOf(JsonObject(mapOf("type" to JsonPrimitive("null"))), JsonObject(rest)))))
                }
            } else {
                JsonObject(converted)
            }
        }
        else -> node
    }
    val schemas = (document["components"] as? JsonObject)?.get("schemas") as? JsonObject ?: refuse("the document has no component schemas")
    return convert(schemas) as JsonObject
}
