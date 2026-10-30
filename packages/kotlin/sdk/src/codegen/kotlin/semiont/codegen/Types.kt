package semiont.codegen

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Kotlin types from component schemas (JSON Schema draft 7, as
 * `draft7Definitions` writes them): a data class per object, an enum class per
 * string enumeration, a sealed interface per `oneOf` or `anyOf`, an alias per
 * named string, a value class per kind of id, a property per schema property,
 * optional where the schema does not require it. It knows the shapes the
 * spec's schemas use and refuses any other, so a schema that grows a new shape
 * fails the build rather than generating something wrong.
 *
 * A property that is required and may be null is stated, as null or a value;
 * one that is optional is absent or a value; one that is optional and may be
 * null is a `Stated`: absent, null or a value, three things. A property that
 * admits one value says which member of a union an object is: it is the
 * type's to state, and is written whatever the encoder's defaults.
 *
 * A union is a sealed interface its named members implement, so a member is
 * the union wherever the union is wanted. One whose schema names the property
 * its members are told apart by, each member stating its own one value of it,
 * is decoded as the member that value names, and a value that is wrong is
 * refused for what is wrong with it. Any other is decoded as the first member
 * that fits. A member that is text, a list or the empty object is a variant of
 * the union's own, since nothing says which union a `String` was meant for.
 *
 * An object whose schema admits properties it does not name keeps them, and
 * writes them back (`rest`). One whose schema admits none refuses one; any
 * other ignores what it does not name, as a later gateway may add some.
 *
 * Java makes a model through its builder: `builder` takes what must be
 * stated, a setter each thing that may be, and `build` makes it. Kotlin names
 * its arguments instead.
 *
 * A kind of id is a value class whose pattern is the check its constructor
 * makes, and decoding goes through that constructor, so a value of the type
 * has always passed its rule.
 */
internal class Generation(
    /** The schemas generated, with every schema they reach. */
    val roots: Set<String>,
    /** The schemas that are kinds of id (specs/src/identifiers/kinds.json). */
    val identifiers: Set<String>,
)

/** What one generation writes: each declaration of the types' package by name, and the identifiers' file. */
internal class Generated(val types: Map<String, String>, val identifiers: String)

internal const val TYPES_PACKAGE = "semiont.types"
internal const val IDENTIFIERS_PACKAGE = "semiont.identifiers"

private const val EMPTY_OBJECT = "EmptyObject"
private const val STATED = "Stated"
private const val INVALID_IDENTIFIER = "InvalidIdentifier"
private const val REST = "rest"

/** The names a generated file imports: no schema may be named as one. */
private val IMPORTED = listOf(
    "kotlinx.serialization.DeserializationStrategy",
    "kotlinx.serialization.EncodeDefault",
    "kotlinx.serialization.ExperimentalSerializationApi",
    "kotlinx.serialization.KSerializer",
    "kotlinx.serialization.SerialName",
    "kotlinx.serialization.Serializable",
    "kotlinx.serialization.SerializationException",
    "kotlinx.serialization.builtins.ListSerializer",
    "kotlinx.serialization.descriptors.PrimitiveKind",
    "kotlinx.serialization.descriptors.PrimitiveSerialDescriptor",
    "kotlinx.serialization.descriptors.SerialDescriptor",
    "kotlinx.serialization.descriptors.nullable",
    "kotlinx.serialization.encoding.Decoder",
    "kotlinx.serialization.encoding.Encoder",
    "kotlinx.serialization.json.JsonArray",
    "kotlinx.serialization.json.JsonContentPolymorphicSerializer",
    "kotlinx.serialization.json.JsonDecoder",
    "kotlinx.serialization.json.JsonElement",
    "kotlinx.serialization.json.JsonEncoder",
    "kotlinx.serialization.json.JsonIgnoreUnknownKeys",
    "kotlinx.serialization.json.JsonObject",
    "kotlinx.serialization.json.JsonPrimitive",
    "kotlinx.serialization.json.jsonObject",
    "kotlinx.serialization.serializer",
)

/** Every declaration of a generation, one after another: what the generator's tests read. */
internal fun types(definitions: JsonObject, generation: Generation): String {
    val generated = generate(definitions, generation)
    return (listOf(generated.identifiers) + generated.types.values).joinToString("\n")
}

internal fun generate(definitions: JsonObject, generation: Generation): Generated {
    for (name in definitions.keys) {
        if (IMPORTED.any { it.substringAfterLast('.') == name }) refuse("$name is a schema's name, and a name the generated code imports")
        if (name in setOf(EMPTY_OBJECT, STATED, INVALID_IDENTIFIER)) refuse("$name is a schema's name, and the generator's own")
    }
    val types = Types(definitions, generation)
    for (root in generation.roots.sorted()) types.named(root)
    return types.finished()
}

/** A file's start: what it is, the opt-ins its declarations need, its package and its imports. */
internal fun header(pkg: String, kinds: Set<String>): String = buildString {
    append("// Generated from the component schemas in specs/src; do not edit.\n")
    append("@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class, kotlin.ExperimentalStdlibApi::class)\n\n")
    append("package $pkg\n\n")
    for (import in IMPORTED) append("import $import\n")
    if (pkg != IDENTIFIERS_PACKAGE) for (kind in kinds.sorted()) append("import $IDENTIFIERS_PACKAGE.$kind\n")
    append("\n")
}

private fun JsonElement?.string(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

private operator fun JsonElement?.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)

/** A placeholder for a declaration's supertypes, filled once every union is known. */
private fun supertypes(name: String): String = "\u0000SUPER:$name\u0000"

private class Types(private val definitions: JsonObject, private val generation: Generation) {
    /** Every declaration of `semiont.types` written, by name, so a schema reached twice is written once. */
    private val written = sortedMapOf<String, String>()

    /** Every kind of id written. */
    private val identifiers = sortedMapOf<String, String>()

    /** The unions each declaration is a member of. */
    private val unionsOf = mutableMapOf<String, MutableSet<String>>()

    fun schema(name: String): JsonObject = definitions[name] as? JsonObject ?: refuse("the spec declares no schema $name")

    fun finished(): Generated {
        val filled = written.mapValues { (name, code) ->
            val unions = unionsOf[name].orEmpty().sorted()
            code.replace(supertypes(name), if (unions.isEmpty()) "" else " : " + unions.joinToString(", "))
        }
        val stray = filled.values.firstOrNull { it.contains("\u0000SUPER:") }
        if (stray != null) refuse("a declaration's supertypes were never filled: ${stray.substringAfter("\u0000SUPER:").substringBefore('\u0000')}")
        return Generated(filled, identifiersFile())
    }

    /** The kinds of id, with what refuses one and, when a rule reads it, what whitespace is. */
    private fun identifiersFile(): String = buildString {
        if (identifiers.isEmpty()) return@buildString
        append(
            """
            |/** A string that is not an id of the kind it was to be. */
            |public class $INVALID_IDENTIFIER(
            |    /** The kind it was to be. */
            |    public val kind: String,
            |    /** The rule of that kind, as the spec writes it. */
            |    public val pattern: String,
            |    /** What was refused. */
            |    public val value: String,
            |) : IllegalArgumentException("\"${'$'}value\" is not a ${'$'}kind: it does not match ${'$'}pattern")
            |
            |""".trimMargin(),
        )
        if (identifiers.values.any { it.contains("isWhitespace(") }) {
            append(
                """
                |
                |/** Whether a code point is whitespace as the spec's patterns read `\s`: ECMAScript's WhiteSpace and LineTerminator. */
                |private fun isWhitespace(c: Int): Boolean =
                |    c == 0x09 || c == 0x0A || c == 0x0B || c == 0x0C || c == 0x0D || c == 0xFEFF || c == 0x2028 || c == 0x2029 ||
                |        Character.getType(c) == Character.SPACE_SEPARATOR.toInt()
                |
                |""".trimMargin(),
            )
        }
        for (code in identifiers.values) append("\n").append(code)
    }

    /** The type a component schema names: written once, here. */
    fun named(name: String): String {
        if (name in generation.identifiers) {
            if (name !in identifiers) identifiers[name] = identifier(name, schema(name))
            return name
        }
        if (name !in written) {
            written[name] = ""
            written[name] = declaration(name, schema(name))
        }
        return name
    }

    /** The name of the type of `owner`'s property `property`, when its schema is written in place: the two names together, and `Value` after them for as long as a component schema already has that name. */
    fun inlineName(owner: String, property: String): String {
        var name = owner + pascal(property)
        while (name in definitions || name in written) name += "Value"
        return name
    }

    fun inline(name: String, schema: JsonObject): String {
        written[name] = ""
        written[name] = declaration(name, schema)
        return name
    }

    fun emptyObject(): String {
        if (EMPTY_OBJECT !in written) {
            written[EMPTY_OBJECT] = "/**\n * An object with no properties.\n */\n@Serializable\npublic data object $EMPTY_OBJECT\n"
        }
        return EMPTY_OBJECT
    }

    fun stated() {
        if (STATED in written) return
        written[STATED] = """
            |/**
            | * A property the spec says may be left out and may be null: absent, null or
            | * a value, three things. An absent one is left out when it is written.
            | */
            |@Serializable(with = $STATED.Serializer::class)
            |public sealed interface $STATED<out T> {
            |    /** Left out. */
            |    public data object Absent : $STATED<Nothing>
            |
            |    /** Stated as null. */
            |    public data object Null : $STATED<Nothing>
            |
            |    /** Stated as a value. */
            |    public data class Value<out T>(public val value: T) : $STATED<T>
            |
            |    /** Absent is no value, and is never written: what writes it leaves defaults out, as the SDK does. */
            |    public class Serializer<T>(private val value: KSerializer<T>) : KSerializer<$STATED<T>> {
            |        override val descriptor: SerialDescriptor = value.descriptor.nullable
            |
            |        override fun serialize(encoder: Encoder, value: $STATED<T>) {
            |            when (value) {
            |                Absent -> throw SerializationException("an absent property is left out: write it with encodeDefaults = false")
            |                Null -> encoder.encodeNull()
            |                is Value -> encoder.encodeSerializableValue(this.value, value.value)
            |            }
            |        }
            |
            |        override fun deserialize(decoder: Decoder): $STATED<T> =
            |            if (decoder.decodeNotNullMark()) Value(decoder.decodeSerializableValue(value)) else Null.also { decoder.decodeNull() }
            |    }
            |}
            |""".trimMargin()
    }

    /** Whether a schema is text, following `$ref`s and unions of text. A kind of id is text. */
    fun isString(schema: JsonElement?): Boolean {
        reference(schema)?.let { return isString(schema(it)) }
        union(schema)?.let { members -> return members.all(::isString) }
        return schema["type"].string() == "string" && schema["enum"] == null
    }

    /** The Kotlin type of a value `owner`'s property `property` holds, not null. */
    fun typeOf(owner: String, property: String, schema: JsonElement?): String {
        if (schema !is JsonObject) refuse("$owner.$property: a schema that is no object: $schema")
        reference(schema)?.let { return named(it) }
        if (schema.isEmpty()) return "JsonElement"
        refuseConst("$owner.$property", schema)
        withoutNull("$owner.$property", schema)?.let { return typeOf(owner, property, it) }
        // An `allOf` of one schema is that schema: the form a `$ref` takes when something is said beside it.
        val allOf = schema["allOf"] as? JsonArray
        if (allOf != null && allOf.size == 1 && reference(allOf[0]) != null && schema.keys.all { it == "allOf" || it == "description" }) {
            return typeOf(owner, property, allOf[0])
        }
        if (allOf != null) return inline(inlineName(owner, property), schema)
        union(schema)?.let { members ->
            members.forEach { refuseConst("$owner.$property", it) }
            return if (members.all(::isString)) "String" else inline(inlineName(owner, property), schema)
        }
        return when (schema["type"].string()) {
            "string" -> if (schema["enum"] != null) inline(inlineName(owner, property), schema) else "String"
            "boolean" -> "Boolean"
            "number" -> "Double"
            "integer" -> "Long"
            "array" -> "kotlin.collections.List<${typeOf(owner, "${property}Item", schema["items"])}>"
            "object" -> {
                val properties = (schema["properties"] as? JsonObject)?.takeIf { it.isNotEmpty() }
                val additional = schema["additionalProperties"]
                val noneMore = (schema["maxProperties"] as? JsonPrimitive)?.longOrNull == 0L
                when {
                    properties != null -> inline(inlineName(owner, property), schema)
                    additional == JsonPrimitive(false) || noneMore -> emptyObject()
                    additional == null || additional == JsonPrimitive(true) -> "JsonObject"
                    else -> "kotlin.collections.Map<String, ${typeOf(owner, "${property}Value", additional)}>"
                }
            }
            else -> refuse("$owner.$property: a schema shape the generator does not know: $schema")
        }
    }

    fun declaration(name: String, raw: JsonObject): String {
        val doc = kdoc("", raw["description"].string())
        union(raw)?.let { members ->
            val property = raw["discriminator"]["propertyName"].string()
            val tags = property?.let { tags(it, members) }
            return unionDeclaration(name, members, if (property != null && tags != null) property to tags else null, doc)
        }
        val schema = (raw["allOf"] as? JsonArray)?.let { JsonObject(merged(name, it)) } ?: raw
        refuseConst(name, schema)
        (schema["enum"] as? JsonArray)?.let { values ->
            if (schema["type"].string() != "string") refuse("$name: only string enumerations are generated")
            return enumDeclaration(name, values, doc)
        }
        if (isString(schema)) return "${doc}public typealias $name = String\n"
        if (schema["type"].string() != "object") refuse("$name: a schema shape the generator does not know: $schema")
        return objectDeclaration(name, schema, doc)
    }

    fun enumDeclaration(name: String, values: JsonArray, doc: String): String = buildString {
        append(doc)
        append("@Serializable\npublic enum class $name(\n    /** The value as the wire spells it. */\n    public val value: String,\n)${supertypes(name)} {\n")
        val taken = mutableSetOf<String>()
        for (value in values) {
            val text = value.string() ?: refuse("$name: an enum value is not a string")
            val variant = variantOf(text)
            if (!taken.add(variant)) refuse("$name: two enum values would both be the constant $variant")
            append("    @SerialName(${literal(text)})\n    $variant(${literal(text)}),\n")
        }
        append("}\n")
    }

    /** One property of an object, as its class and its builder have it. */
    inner class Property(owner: String, val wire: String, schema: JsonElement, required: Boolean) {
        val name = propertyName(wire)
        val type = typeOf(owner, wire, schema)
        val nullable = schema is JsonObject && withoutNull("$owner.$wire", schema) != null
        val doc = kdoc("    ", schema["description"].string())
        val boxed = type in generation.identifiers
        val only = if (required) onlyValue(schema) else null
        val form = when {
            required && nullable -> Form.STATED_NULLABLE
            required && only != null -> Form.SINGLE
            required -> Form.REQUIRED
            nullable -> Form.THREE_STATES
            else -> Form.OPTIONAL
        }

        /** As the data class declares it. */
        fun declared(): String {
            val annotations = buildString {
                append("    @SerialName(${literal(wire)})\n")
                if (form == Form.SINGLE) append("    @EncodeDefault\n")
                if (boxed) append("    @get:JvmExposeBoxed\n")
            }
            val declared = when (form) {
                Form.STATED_NULLABLE -> "$type?"
                Form.SINGLE -> "$type = $type.${variantOf(only!!)}"
                Form.REQUIRED -> type
                Form.THREE_STATES -> "$STATED<$type> = $STATED.Absent"
                Form.OPTIONAL -> "$type? = null"
            }
            return "$doc${annotations}    public val ${code(name)}: $declared,\n"
        }

        /** The type a builder takes it as. */
        val taken: String = when (form) {
            Form.STATED_NULLABLE, Form.THREE_STATES, Form.OPTIONAL -> "$type?"
            Form.SINGLE, Form.REQUIRED -> type
        }
    }

    enum class Form { STATED_NULLABLE, SINGLE, REQUIRED, THREE_STATES, OPTIONAL }

    fun objectDeclaration(name: String, schema: JsonObject, doc: String): String {
        val stated = schema["properties"] as? JsonObject ?: JsonObject(emptyMap())
        val required = (schema["required"] as? JsonArray)?.mapNotNull { it.string() }.orEmpty().toSet()
        val additional = schema["additionalProperties"]
        val open = when (additional) {
            JsonPrimitive(true) -> true
            null, JsonPrimitive(false) -> false
            else -> refuse("$name: properties beside additionalProperties $additional, which the generator does not know")
        }
        val closed = additional == JsonPrimitive(false)
        if (stated.isEmpty() && open) return "${doc}public typealias $name = JsonObject\n"
        if (stated.isEmpty()) {
            // An object with nothing to state is one value: the same `{}` every time.
            return "$doc@Serializable\n${if (closed) "" else "@JsonIgnoreUnknownKeys\n"}public data object $name${supertypes(name)}\n"
        }
        val properties = stated.map { (wire, property) -> Property(name, wire, property, wire in required) }
        val names = mutableSetOf<String>()
        for (property in properties) {
            if (!names.add(property.name)) refuse("$name: two properties are named ${property.name} in Kotlin")
            if (open && property.name == REST) refuse("$name: a property is named $REST, which is where an open object keeps what it does not name")
            if (property.name == "build") refuse("$name: a property is named build, which is its builder's last call")
        }
        if (properties.any { it.form == Form.THREE_STATES }) stated()
        return buildString {
            append(doc)
            if (open) append("@Serializable(with = $name.Serializer::class)\n") else append("@Serializable\n")
            if (!closed && !open) append("@JsonIgnoreUnknownKeys\n")
            append("public data class $name(\n")
            properties.forEach { append(it.declared()) }
            if (open) append("    /** Every property the schema does not name, as it came. */\n    public val $REST: JsonObject = JsonObject(emptyMap()),\n")
            append(")${supertypes(name)} {\n")
            append(builder(name, properties, open))
            if (open) append(openSerializer(name, properties))
            append("}\n")
        }
    }

    /** What Java makes one with: the builder, and the companion's `builder`. */
    fun builder(name: String, properties: List<Property>, open: Boolean): String = buildString {
        val given = properties.filter { it.form == Form.REQUIRED || it.form == Form.STATED_NULLABLE }
        val set = properties.filter { it.form == Form.OPTIONAL || it.form == Form.THREE_STATES }
        val boxes = given.any { it.boxed }
        append("    /** How Java makes a `$name`: `builder` takes what it must state, a setter each thing it may, and `build` makes it. */\n")
        append("    public class Builder internal constructor(\n")
        given.forEach { append("        private val ${code(it.name)}: ${it.taken},\n") }
        append("    ) {\n")
        for (property in set) {
            val field = if (property.form == Form.THREE_STATES) "$STATED<${property.type}> = $STATED.Absent" else "${property.taken} = null"
            append("        private var ${code(property.name)}: $field\n")
        }
        if (open) append("        private var $REST: JsonObject = JsonObject(emptyMap())\n")
        for (property in set) {
            append("\n")
            if (property.boxed) append("        @JvmExposeBoxed\n")
            val value = if (property.form == Form.THREE_STATES) "if (${code(property.name)} == null) $STATED.Null else $STATED.Value(${code(property.name)})" else code(property.name)
            append("        public fun ${code(property.name)}(${code(property.name)}: ${property.taken}): Builder {\n")
            append("            this.${code(property.name)} = $value\n            return this\n        }\n")
        }
        if (open) append("\n        public fun $REST($REST: JsonObject): Builder {\n            this.$REST = $REST\n            return this\n        }\n")
        val arguments = properties.filter { it.form != Form.SINGLE }.map { "${code(it.name)} = ${code(it.name)}" } + (if (open) listOf("$REST = $REST") else emptyList())
        append("\n        public fun build(): $name = $name(${arguments.joinToString(", ")})\n")
        append("    }\n\n")
        append("    public companion object {\n")
        append("        /** A builder of a `$name` that states these, and what its setters add. */\n")
        append("        @JvmStatic\n")
        if (boxes) append("        @JvmExposeBoxed\n")
        val parameters = given.joinToString(", ") { "${code(it.name)}: ${it.taken}" }
        append("        public fun builder($parameters): Builder = Builder(${given.joinToString(", ") { code(it.name) }})\n")
        append("    }\n")
    }

    /** An open object's serializer: what the schema names, read and written as the class, and the rest kept as it came. */
    fun openSerializer(name: String, properties: List<Property>): String = buildString {
        append("\n    @Serializable\n    internal data class Known(\n")
        properties.forEach { append(it.declared().replace("    @get:JvmExposeBoxed\n", "").prependIndent("    ")) }
        append("    )\n\n")
        append("    internal object Serializer : KSerializer<$name> {\n")
        append("        private val named: Set<String> = setOf(${properties.joinToString(", ") { literal(it.wire) }})\n\n")
        append("        override val descriptor: SerialDescriptor = SerialDescriptor(${literal("$TYPES_PACKAGE.$name")}, Known.serializer().descriptor)\n\n")
        append("        override fun deserialize(decoder: Decoder): $name {\n")
        append("            val json = decoder as? JsonDecoder ?: throw SerializationException(${literal("a $name is read from JSON alone")})\n")
        append("            val all = json.decodeJsonElement().jsonObject\n")
        append("            val known = json.json.decodeFromJsonElement(Known.serializer(), JsonObject(all.filterKeys { it in named }))\n")
        val read = properties.map { "${code(it.name)} = known.${code(it.name)}" } + "$REST = JsonObject(all.filterKeys { it !in named })"
        append("            return $name(${read.joinToString(", ")})\n        }\n\n")
        append("        override fun serialize(encoder: Encoder, value: $name) {\n")
        append("            val json = encoder as? JsonEncoder ?: throw SerializationException(${literal("a $name is written as JSON alone")})\n")
        val known = properties.map { "${code(it.name)} = value.${code(it.name)}" }
        append("            val known = json.json.encodeToJsonElement(Known.serializer(), Known(${known.joinToString(", ")})).jsonObject\n")
        append("            json.encodeJsonElement(JsonObject(known + value.$REST))\n        }\n    }\n")
    }

    /** A kind of id: text no code can make but through its constructor, which holds it to the schema's pattern. */
    fun identifier(name: String, schema: JsonObject): String {
        if (schema["type"].string() != "string") refuse("$name: a kind of id that is not a string: $schema")
        val pattern = schema["pattern"].string() ?: refuse("$name: a kind of id states no pattern")
        val rule = Rule.of(name, pattern)
        return buildString {
            append(kdoc("", schema["description"].string()))
            append("@Serializable\n@JvmExposeBoxed\n@JvmInline\npublic value class $name(\n    /** The id as text. */\n    public val value: String,\n) {\n")
            append("    init {\n        if (!admits(value)) throw $INVALID_IDENTIFIER(${literal(name)}, PATTERN, value)\n    }\n\n")
            append("    override fun toString(): String = value\n\n")
            append("    public companion object {\n")
            append("        /** The rule a value is held to, as the spec writes it. */\n")
            append("        public const val PATTERN: String = ${literal(pattern)}\n\n")
            append("        /** `value` as a `$name`, or null when it is not one. */\n")
            append("        @JvmStatic\n        @JvmExposeBoxed\n")
            append("        public fun parse(value: String): $name? = if (admits(value)) $name(value) else null\n\n")
            append("        private fun admits(value: String): Boolean {\n")
            append(rule.check())
            append("        }\n    }\n}\n")
        }
    }

    /** An `allOf`'s members as one object: the properties of each, a later member's refining an earlier's, and every member's requirements. */
    fun merged(name: String, members: JsonArray): Map<String, JsonElement> {
        val properties = linkedMapOf<String, JsonElement>()
        val required = linkedSetOf<String>()
        var closed = false
        for (raw in members) {
            val member = reference(raw)?.let(::schema) ?: raw as? JsonObject ?: refuse("$name: an allOf member that is no object")
            if (member["type"].string() != "object") refuse("$name: an allOf member that is not an object: $member")
            (member["properties"] as? JsonObject)?.let { properties.putAll(it) }
            (member["required"] as? JsonArray)?.mapNotNull { it.string() }?.let { required.addAll(it) }
            closed = closed || member["additionalProperties"] == JsonPrimitive(false)
        }
        val merged = mutableMapOf<String, JsonElement>(
            "type" to JsonPrimitive("object"),
            "properties" to JsonObject(properties),
            "required" to JsonArray(required.map(::JsonPrimitive)),
        )
        if (closed) merged["additionalProperties"] = JsonPrimitive(false)
        return merged
    }

    /** The value of `property` each member of a union states, when every member is an object that must state it, each admits one value, and no two admit the same. */
    fun tags(property: String, members: List<JsonElement>): List<String>? {
        val tags = mutableListOf<String>()
        for (raw in members) {
            val member = reference(raw)?.let(::schema) ?: raw
            val requires = (member["required"] as? JsonArray)?.any { it.string() == property } == true
            val tag = onlyValue(member["properties"][property]).takeIf { requires } ?: return null
            if (tag in tags) return null
            tags += tag
        }
        return tags
    }

    /** Whether a type is a declaration of its own that a union's members can be: not an alias, nor a type of Kotlin's or the JSON library's. */
    fun implementable(type: String): Boolean = written[type]?.contains("public typealias $type =") == false && type != EMPTY_OBJECT

    fun unionDeclaration(name: String, members: List<JsonElement>, toldApart: Pair<String, List<String>>?, doc: String): String {
        /** Each member: the declaration it is, and the kinds of JSON it is read from. */
        class Member(val type: String, val reads: Set<String>)
        val variants = StringBuilder()
        val read = mutableListOf<Member>()
        fun variant(variant: String, code: String, reads: Set<String>) {
            if (read.any { it.type == "$name.$variant" }) refuse("$name: two union members would both be the variant $variant")
            variants.append(code)
            read += Member("$name.$variant", reads)
        }
        fun member(type: String, reads: Set<String>) {
            unionsOf.getOrPut(type) { mutableSetOf() } += name
            read += Member(type, reads)
        }
        for (member in members) {
            val target = reference(member)
            val isEmpty = member["type"].string() == "object" && member["properties"] == null &&
                ((member["maxProperties"] as? JsonPrimitive)?.longOrNull == 0L || member["additionalProperties"] == JsonPrimitive(false))
            when {
                target != null && !isString(member) -> {
                    val type = named(target)
                    val reads = when {
                        schema(target)["enum"] != null -> setOf("text")
                        union(schema(target)) != null -> setOf("text", "list", "object")
                        else -> setOf("object")
                    }
                    if (implementable(type)) member(type, reads) else variant(type, wrapped(name, type, "$TYPES_PACKAGE.$type"), reads)
                }
                target != null && target in generation.identifiers -> variant(named(target), wrapped(name, target, "$IDENTIFIERS_PACKAGE.$target"), setOf("text"))
                isEmpty -> variant("Empty", "    /** The empty object. */\n    @Serializable\n    public data object Empty : $name\n\n", setOf("object"))
                isString(member) -> variant("Text", wrapped(name, "Text", "String"), setOf("text"))
                member["type"].string() == "array" -> variant("List", wrapped(name, "List", "kotlin.collections.List<${typeOf(name, "Item", member["items"])}>"), setOf("list"))
                member["type"].string() == "object" -> {
                    // An inline member is named by the one value its discriminant takes, when it has one.
                    val type = typeOf(name, discriminant(member)?.let(::pascal) ?: "Object", member)
                    if (implementable(type)) member(type, setOf("object")) else variant("Object", wrapped(name, "Object", type), setOf("object"))
                }
                else -> refuse("$name: a union member the generator does not know: $member")
            }
        }
        return buildString {
            append(doc)
            append("@Serializable(with = ${name}Serializer::class)\npublic sealed interface $name${supertypes(name)} {\n")
            append(variants.toString().trimEnd('\n'))
            append("\n}\n\n")
            append("internal object ${name}Serializer : JsonContentPolymorphicSerializer<$name>($name::class) {\n")
            append("    override fun selectDeserializer(element: JsonElement): DeserializationStrategy<$name> =\n")
            if (toldApart != null) {
                val (property, tags) = toldApart
                val said = "a $name states a `$property` that is one of ${tags.joinToString(", ") { "`$it`" }}"
                append("        when (((element as? JsonObject)?.get(${literal(property)}) as? JsonPrimitive)?.content) {\n")
                for ((tag, member) in tags.zip(read)) append("            ${literal(tag)} -> ${member.type}.serializer()\n")
                append("            else -> throw SerializationException(${literal(said)})\n        }\n")
            } else {
                val fits = { reads: String -> read.filter { reads in it.reads }.joinToString(", ") { "${it.type}.serializer()" } }
                append("        firstThatFits<$name>(\n            element,\n")
                append("            when (element) {\n")
                append("                is JsonPrimitive -> if (element.isString) listOf(${fits("text")}) else emptyList()\n")
                append("                is JsonArray -> listOf(${fits("list")})\n")
                append("                is JsonObject -> listOf(${fits("object")})\n")
                append("            },\n            ${literal(name)},\n        )\n")
            }
            append("}\n")
        }
    }

    /** A variant of a union that holds a value of `type`, written as the value itself. `type` is qualified where the variant is named as it is, which would shadow it. */
    fun wrapped(union: String, variant: String, type: String): String {
        val descriptor = if (type == "String") {
            "PrimitiveSerialDescriptor(${literal("$TYPES_PACKAGE.$union.$variant")}, PrimitiveKind.STRING)"
        } else {
            "SerialDescriptor(${literal("$TYPES_PACKAGE.$union.$variant")}, value.descriptor)"
        }
        return """
        |    /** A member that is a `${type.substringAfterLast('.')}`, as the value itself. */
        |    @Serializable(with = $variant.Serializer::class)
        |    public data class $variant(public val value: $type) : $union {
        |        internal object Serializer : KSerializer<$variant> {
        |            private val value: KSerializer<$type> = kotlinx.serialization.serializer()
        |
        |            override val descriptor: SerialDescriptor = $descriptor
        |
        |            override fun serialize(encoder: Encoder, value: $variant) {
        |                encoder.encodeSerializableValue(this.value, value.value)
        |            }
        |
        |            override fun deserialize(decoder: Decoder): $variant = $variant(decoder.decodeSerializableValue(value))
        |        }
        |    }
        |
        |""".trimMargin()
    }
}

/**
 * A schema that also admits null (`type: [T, "null"]` or a union with a
 * `null` member, draft 7's forms of OpenAPI's `nullable`), as the schema
 * without it; `null` when it admits no null.
 */
private fun withoutNull(what: String, schema: JsonObject): JsonObject? {
    union(schema)?.let { members ->
        val others = members.filter { it["type"].string() != "null" }
        return when {
            others.size == members.size -> null
            others.size == 1 -> others[0] as? JsonObject ?: refuse("$what: a union member that is no object")
            else -> JsonObject(mapOf("anyOf" to JsonArray(others)))
        }
    }
    val types = schema["type"] as? JsonArray ?: return null
    val others = types.filter { it.string() != "null" }
    if (others.size != 1 || others.size == types.size) refuse("$what: a schema of several types the generator does not know: $schema")
    return JsonObject(schema + ("type" to others[0]))
}

/** The single value an object's discriminating property takes: the first of its properties that admits exactly one string. */
private fun discriminant(objectSchema: JsonElement): String? =
    (objectSchema["properties"] as? JsonObject)?.values?.firstNotNullOfOrNull(::onlyValue)

/** `const` is JSON Schema's and not OpenAPI 3.0's, the dialect the spec is written in: a schema that admits one value states it as an `enum` of one. */
private fun refuseConst(what: String, schema: JsonElement?) {
    if (schema["const"] != null) refuse("$what: `const` is not OpenAPI 3.0: state the one value as an `enum` of one")
}

/** The one string a schema admits, when it admits exactly one. */
private fun onlyValue(schema: JsonElement?): String? = (schema["enum"] as? JsonArray)?.singleOrNull()?.string()

private fun reference(schema: JsonElement?): String? =
    schema["\$ref"].string()?.let { it.removePrefix("#/definitions/").takeIf { name -> name != it } ?: refuse("\$ref $it is not a component schema") }

private fun union(schema: JsonElement?): List<JsonElement>? = (schema["oneOf"] as? JsonArray ?: schema["anyOf"] as? JsonArray)?.toList()
