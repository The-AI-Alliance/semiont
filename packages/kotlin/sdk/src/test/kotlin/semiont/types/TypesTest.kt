package semiont.types

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.StructureKind
import kotlinx.serialization.encoding.CompositeDecoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import semiont.Spec
import semiont.identifiers.AnnotationId
import semiont.identifiers.ResourceId
import semiont.sameJson
import kotlin.io.path.listDirectoryEntries
import kotlin.io.path.nameWithoutExtension

/** The protocol's shapes, as generated: one type per schema, typed by the kinds of id, written by the wire's names. */
class TypesTest {
    private val kinds = Spec.read("identifiers/kinds.json").jsonObject.getValue("kinds").jsonArray.map { it.jsonObject }
    private val kindNames = kinds.map { it.getValue("schema").jsonPrimitive.content }.toSet()
    private val schemas = Spec.src.resolve("components/schemas").listDirectoryEntries("*.json").map { it.nameWithoutExtension }.sorted()

    /** A schema that is text and nothing more: a name for `String`, which is no class of its own. */
    private fun isPlainText(name: String): Boolean {
        val schema = Spec.read("components/schemas/$name.json").jsonObject
        return schema["type"]?.jsonPrimitive?.content == "string" && "enum" !in schema && name !in kindNames
    }

    private fun typeOf(name: String): KSerializer<Any> =
        serializer(Class.forName(if (name in kindNames) "semiont.identifiers.$name" else "semiont.types.$name"))

    @Test
    fun everySchemaTheSpecNamesIsATypeHere() {
        assertTrue(schemas.size > 250)
        val missing = schemas.filterNot(::isPlainText).filter { runCatching { typeOf(it) }.isFailure }
        assertEquals(emptyList<String>(), missing)
    }

    /** The element a descriptor's element holds, through a list or a map's values. */
    private fun held(descriptor: SerialDescriptor): SerialDescriptor =
        if (descriptor.kind == StructureKind.LIST || descriptor.kind == StructureKind.MAP) held(descriptor.getElementDescriptor(descriptor.elementsCount - 1)) else descriptor

    /** Whether what a descriptor holds is of `kind`: the kind itself, or a union one of whose variants is named for it. */
    private fun isOfKind(descriptor: SerialDescriptor, kind: String): Boolean {
        val named = held(descriptor).serialName.removeSuffix("?")
        if (named == "semiont.identifiers.$kind") return true
        val union = Regex("""JsonContentPolymorphicSerializer<(\w+)>""").find(named)?.groupValues?.get(1) ?: return false
        return Class.forName("semiont.types.$union").permittedSubclasses.orEmpty().any { it.simpleName == kind }
    }

    @Test
    fun aPropertyNamedForAKindOfIdIsTypedByIt() {
        val named = kinds.flatMap { kind ->
            kind.getValue("properties").jsonArray.map { it.jsonPrimitive.content to kind.getValue("schema").jsonPrimitive.content }
        }.toMap()
        var held = 0
        val loose = mutableListOf<String>()
        for (name in schemas.filterNot(::isPlainText).filterNot { it in kindNames }) {
            val descriptor = typeOf(name).descriptor
            if (descriptor.kind != StructureKind.CLASS) continue
            for (index in 0 until descriptor.elementsCount) {
                val kind = named[descriptor.getElementName(index)] ?: continue
                held += 1
                val element = descriptor.getElementDescriptor(index)
                if (!isOfKind(element, kind)) loose += "$name.${descriptor.getElementName(index)} is a ${held(element).serialName}, not a $kind"
            }
        }
        assertEquals(emptyList<String>(), loose)
        assertTrue(held > 150, "the census found $held id fields: it is reading the wrong thing")
    }

    @Test
    fun aRequiredPropertyTheSpecSaysMayBeNullIsStatedAsNullOrAValue() {
        var held = 0
        val loose = mutableListOf<String>()
        for (name in schemas.filterNot(::isPlainText).filterNot { it in kindNames }) {
            val schema = Spec.read("components/schemas/$name.json").jsonObject
            val required = (schema["required"] as? JsonArray)?.map { it.jsonPrimitive.content }.orEmpty().toSet()
            val nullable = (schema["properties"] as? JsonObject)?.filter { (wire, stated) ->
                wire in required && (stated as? JsonObject)?.get("nullable") == JsonPrimitive(true)
            }?.keys.orEmpty()
            if (nullable.isEmpty()) continue
            val descriptor = typeOf(name).descriptor
            for (wire in nullable) {
                held += 1
                val index = descriptor.getElementIndex(wire)
                when {
                    index == CompositeDecoder.UNKNOWN_NAME -> loose += "$name.$wire is no property of the type"
                    !descriptor.getElementDescriptor(index).isNullable -> loose += "$name.$wire may not be null"
                    descriptor.isElementOptional(index) -> loose += "$name.$wire may be left out"
                }
            }
        }
        assertEquals(emptyList<String>(), loose)
        assertTrue(held >= 5, "the census found $held required nullable properties: it is reading the wrong thing")
    }

    @Test
    fun aModelIsMadeByItsKotlinNamesAndWrittenByTheWires() {
        val command = MarkDeleteCommand(annotationId = AnnotationId("a-1"), resourceId = ResourceId("res-1"))
        assertEquals("""{"annotationId":"a-1","resourceId":"res-1"}""", wireJson.encodeToString(MarkDeleteCommand.serializer(), command))
        assertEquals(command, wireJson.decodeFromString(MarkDeleteCommand.serializer(), """{"annotationId":"a-1","resourceId":"res-1"}"""))
    }

    @Test
    fun whatAModelReadsItWritesBackAsItCame() {
        // Text the spec gives a format (a time, a URI) stays the text it was,
        // and what an open object does not name is kept and written back.
        val described = kotlinx.serialization.json.Json.parseToJsonElement(
            """{"@context":"https://schema.org/","@id":"res-1","name":"Described",""" +
                """"representations":[{"mediaType":"text/plain","created":"2026-10-06T05:04:06.111Z","modified":"2026-10-06T05:04:06.123456789+02:00","x-checksum":"abc"}],""" +
                """"license":"https://example.org","isPartOf":["HTTPS://Example.org/a b"],"dateCreated":"2026-10-06T05:04:06+00:00","sameAs":["https://example.org/r"]}""",
        )
        val written = wireJson.encodeToJsonElement(ResourceDescriptor.serializer(), wireJson.decodeFromJsonElement(ResourceDescriptor.serializer(), described))
        assertTrue(sameJson(described, written), "$described was written back as $written")
    }

    @Test
    fun aDiscriminatedUnionNamesWhatIsWrongWithTheMemberItsTagNames() {
        val refused = assertThrows(SerializationException::class.java) {
            wireJson.decodeFromJsonElement(JobProgressMessage.serializer(), JsonObject(mapOf("code" to JsonPrimitive("no-such-code"))))
        }
        assertTrue(refused.message.orEmpty().contains("a JobProgressMessage states a `code` that is one of"), refused.message)
    }
}
