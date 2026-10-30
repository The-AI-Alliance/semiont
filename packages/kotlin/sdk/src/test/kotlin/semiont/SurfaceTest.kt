package semiont

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import semiont.bus.decoded
import semiont.bus.Typed
import semiont.channels.Channel
import semiont.channels.Channels
import semiont.errors.SemiontError
import semiont.identifiers.AnnotationId
import semiont.identifiers.JobId
import semiont.identifiers.ResourceId
import semiont.transport.Broadcast
import semiont.transport.ConnectionState
import semiont.transport.Content
import semiont.transport.ContentStream
import semiont.transport.ContentTransport
import semiont.transport.Events
import semiont.transport.Frame
import semiont.transport.FrameSink
import semiont.transport.GatewayOperations
import semiont.transport.PendingReply
import semiont.transport.PutBinaryRequest
import semiont.transport.ReplyRouter
import semiont.transport.ResourceHold
import semiont.transport.Transport
import semiont.transport.Upload
import semiont.transport.Watched
import semiont.types.AnchoredTextAnswer
import semiont.types.AnnotationSelector
import semiont.types.BindBodyOperation
import semiont.types.BindInitiateCommand
import semiont.types.BrowseDirectoryRequestSort
import semiont.types.CreateAnnotationRequest
import semiont.types.GatheredContext
import semiont.types.GenerationJobParams
import semiont.types.GetAnnotationsResponse
import semiont.types.GetResourceResponse
import semiont.types.HealthResponse
import semiont.types.MarkJobParams
import semiont.types.MarkSubmitEvent
import semiont.types.MatchSearchRequest
import semiont.types.MediaTokenResponse
import semiont.types.Motivation
import semiont.types.ProtectedResourceMetadata
import semiont.types.ResourceErrorEvent
import semiont.types.StatusResponse
import semiont.types.TagSchema
import semiont.types.UserResponse
import semiont.types.wireJson
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList

/** `value` with every `{"$fixture": name}` in it the table's fixture of that name. */
private fun resolved(value: JsonElement, fixtures: JsonObject): JsonElement = when (value) {
    is JsonObject -> value["\$fixture"]?.let { fixtures.getValue(it.jsonPrimitive.content) } ?: JsonObject(value.mapValues { resolved(it.value, fixtures) })
    is JsonArray -> JsonArray(value.map { resolved(it, fixtures) })
    else -> value
}

/** A case's arguments, read as the method takes them. */
private class Args(private val stated: JsonObject, private val fixtures: JsonObject) {
    operator fun get(name: String): JsonElement? = stated[name]?.let { resolved(it, fixtures) }

    fun getValue(name: String): JsonElement = get(name) ?: error("the case states no $name")

    fun text(name: String): String = getValue(name).jsonPrimitive.content

    fun texts(name: String): List<String> = getValue(name).jsonArray.map { it.jsonPrimitive.content }

    fun <T> read(name: String, serializer: KSerializer<T>): T = wireJson.decodeFromJsonElement(serializer, getValue(name))

    fun resource(name: String = "resourceId"): ResourceId = ResourceId(text(name))

    fun annotation(name: String = "annotationId"): AnnotationId = AnnotationId(text(name))

    fun job(): JobId = JobId(text("jobId"))
}

/** The filters a case states for a list or a search: the first hundred, and the rest unstated, where it states none. */
private class Filters(args: Args) {
    private val stated = args["filters"]?.jsonObject ?: JsonObject(emptyMap())
    val limit: Long = stated["limit"]?.jsonPrimitive?.long ?: 100
    val offset: Long = stated["offset"]?.jsonPrimitive?.long ?: 0
    val archived: Boolean? = stated["archived"]?.jsonPrimitive?.boolean
    val entityType: String? = stated["entityType"]?.jsonPrimitive?.content
}

/** A method as a case calls it. */
private typealias Call = suspend (SemiontClient, Args) -> Any?

private fun <T> list(of: KSerializer<T>) = ListSerializer(of)

/** Each method this SDK has, as its cases call it, by `namespace.method`. */
private val calls: Map<String, Call> = mapOf(
    "frame.addEntityType" to { c, a -> c.frame.addEntityType(a.text("type")) },
    "frame.addEntityTypes" to { c, a -> c.frame.addEntityTypes(a.texts("types")) },
    "frame.addTagSchema" to { c, a -> c.frame.addTagSchema(a.read("schema", TagSchema.serializer())) },
    "browse.resource" to { c, a -> c.browse.resource(a.resource()).fresh() },
    "browse.resources" to { c, a ->
        val filters = Filters(a)
        c.browse.resources(filters.limit, filters.offset, filters.archived, filters.entityType).fresh()
    },
    "browse.annotations" to { c, a -> c.browse.annotations(a.resource()).fresh() },
    "browse.annotation" to { c, a -> c.browse.annotation(a.resource(), a.annotation()).fresh() },
    "browse.entityTypes" to { c, _ -> c.browse.entityTypes().fresh() },
    "browse.tagSchemas" to { c, _ -> c.browse.tagSchemas().fresh() },
    "browse.engines" to { c, _ -> c.browse.engines().fresh() },
    "browse.events" to { c, a -> c.browse.events(a.resource()).fresh() },
    "browse.resourceGraph" to { c, a -> c.browse.resourceGraph(a.resource()) },
    "browse.resourceAnchoredText" to { c, a -> c.browse.resourceAnchoredText(a.resource()) },
    "browse.resourceContent" to { c, a -> c.browse.resourceContent(a.resource()) },
    "browse.resourceRepresentation" to { c, a -> c.browse.resourceRepresentation(a.resource()) },
    "browse.resourceRepresentationStream" to { c, a -> c.browse.resourceRepresentationStream(a.resource()) },
    "browse.resourceEvents" to { c, a -> c.browse.resourceEvents(a.resource()) },
    "browse.annotationHistory" to { c, a -> c.browse.annotationHistory(a.resource(), a.annotation()) },
    "browse.files" to { c, a ->
        if (a["dirPath"] == null) c.browse.files() else c.browse.files(a.text("dirPath"), a.read("sort", BrowseDirectoryRequestSort.serializer()))
    },
    "browse.kb" to { c, _ -> c.browse.kb() },
    "browse.click" to { c, a -> c.browse.click(a.annotation()) },
    "browse.openResource" to { c, a -> c.browse.openResource(a.resource()) },
    "browse.resourceViewed" to { c, a -> c.browse.resourceViewed(a.resource()) },
    "mark.annotation" to { c, a -> c.mark.annotation(a.read("input", CreateAnnotationRequest.serializer())) },
    "mark.delete" to { c, a -> c.mark.delete(a.resource(), a.annotation()) },
    "mark.archive" to { c, a -> c.mark.archive(a.resource()) },
    "mark.unarchive" to { c, a -> c.mark.unarchive(a.resource()) },
    "mark.updateEntityTypes" to { c, a -> c.mark.updateEntityTypes(a.resource(), a.texts("current"), a.texts("updated")) },
    "mark.delegate" to { c, a -> c.mark.delegate(a.resource(), a.read("params", MarkJobParams.serializer())).await() },
    "mark.request" to { c, a ->
        c.mark.request(a.resource("source"), a.read("selector", AnnotationSelector.serializer()), a.read("motivation", Motivation.serializer()))
    },
    "mark.submit" to { c, a -> c.mark.submit(a.read("input", MarkSubmitEvent.serializer())) },
    "mark.reportDeleteError" to { c, a -> c.mark.reportDeleteError(a.read("input", ResourceErrorEvent.serializer())) },
    "bind.body" to { c, a -> c.bind.body(a.resource(), a.annotation(), a.read("operations", list(BindBodyOperation.serializer()))) },
    "bind.initiate" to { c, a -> c.bind.initiate(a.read("input", BindInitiateCommand.serializer())) },
    "bind.reportBodyError" to { c, a -> c.bind.reportBodyError(a.read("input", ResourceErrorEvent.serializer())) },
    "gather.resource" to { c, a ->
        val options = a["options"]?.jsonObject
        if (options == null) {
            c.gather.resource(a.resource())
        } else {
            c.gather.resource(
                a.resource(),
                depth = options["depth"]?.jsonPrimitive?.long ?: 2,
                maxResources = options["maxResources"]?.jsonPrimitive?.long ?: 10,
                includeContent = options["includeContent"]?.jsonPrimitive?.boolean ?: true,
                includeSummary = options["includeSummary"]?.jsonPrimitive?.boolean ?: false,
                excludeEntityTypes = options["excludeEntityTypes"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
            )
        }
    },
    "gather.referencedBy" to { c, a -> c.gather.referencedBy(a.resource()).fresh() },
    "gather.annotation" to { c, a ->
        val options = a["options"]?.jsonObject ?: JsonObject(emptyMap())
        c.gather.annotation(
            a.resource(),
            a.annotation(),
            contextWindow = options["contextWindow"]?.jsonPrimitive?.long ?: 2000,
            includeSourceContext = options["includeSourceContext"]?.jsonPrimitive?.boolean,
            includeTargetContext = options["includeTargetContext"]?.jsonPrimitive?.boolean,
        ).await()
    },
    "match.search" to { c, a ->
        val options = a["options"]?.jsonObject ?: JsonObject(emptyMap())
        c.match.search(
            a.resource(),
            a.annotation("referenceId"),
            a.read("context", GatheredContext.serializer()),
            limit = options["limit"]?.jsonPrimitive?.long ?: 10,
            useSemanticScoring = options["useSemanticScoring"]?.jsonPrimitive?.boolean ?: true,
        ).await()
    },
    "match.resources" to { c, a ->
        val filters = Filters(a)
        c.match.resources(a.text("search"), filters.limit, filters.offset, filters.archived, filters.entityType).fresh()
    },
    "match.requestSearch" to { c, a -> c.match.requestSearch(a.read("input", MatchSearchRequest.serializer()), a.text("correlationId")) },
    "yield.resource" to { c, a ->
        val data = a.getValue("data").jsonObject
        fun text(name: String) = data.getValue(name).jsonPrimitive.content
        c.yield.resource(PutBinaryRequest(name = text("name"), file = text("content").toByteArray(), format = text("format"), storageUri = text("storageUri")))
    },
    "yield.delegate" to { c, a -> c.yield.delegate(a.read("params", GenerationJobParams.serializer()), a["stallDeadlineMs"]?.jsonPrimitive?.long).await() },
    "yield.createFromToken" to { c, a ->
        val options = a.getValue("options").jsonObject
        fun text(name: String) = options.getValue(name).jsonPrimitive.content
        c.yield.createFromToken(text("token"), text("name"), text("content"), options["archiveOriginal"]?.jsonPrimitive?.boolean)
    },
    "yield.cloneToken" to { c, a -> c.yield.cloneToken(a.resource()) },
    "yield.fromToken" to { c, a -> c.yield.fromToken(a.text("token")) },
    "yield.clone" to { c, _ -> c.yield.clone() },
    "beckon.attention" to { c, a -> c.beckon.attention(a.resource(), a.annotation()) },
    "beckon.click" to { c, a -> c.beckon.click(a.annotation()) },
    "beckon.openResource" to { c, a -> c.beckon.openResource(a.resource()) },
    "beckon.sparkleAll" to { c, a -> c.beckon.sparkleAll(a.annotation()) },
    "beckon.hover" to { c, a -> c.beckon.hover(a["annotationId"]?.takeUnless { it is JsonNull }?.let { AnnotationId(it.jsonPrimitive.content) }) },
    "beckon.sparkle" to { c, a -> c.beckon.sparkle(a.annotation()) },
    "job.queued" to { c, _ -> c.job.queued() },
    "job.progress" to { c, _ -> c.job.progress() },
    "job.complete" to { c, _ -> c.job.complete() },
    "job.fail" to { c, _ -> c.job.fail() },
    "job.status" to { c, a -> c.job.status(a.job()) },
    "job.pollUntilComplete" to { c, a -> c.job.pollUntilComplete(a.job(), everyMs = 1_000, withinMs = 60_000) },
    "job.cancel" to { c, a -> c.job.cancel(a.job()) },
    "auth.me" to { c, _ -> c.auth.me() },
    "auth.mediaToken" to { c, a -> c.auth.mediaToken(a.resource()) },
    "auth.protectedResourceMetadata" to { c, _ -> c.auth.protectedResourceMetadata() },
    "system.healthCheck" to { c, _ -> c.system.healthCheck() },
    "system.status" to { c, _ -> c.system.status() },
)

/** The registry's channel of `name`, as the SDK has it. */
private fun channelNamed(name: String): Channel<*> = Channels::class.java.fields.map { it.get(null) }.filterIsInstance<Channel<*>>().single { it.name == name }

/**
 * The client's surface against specs/src/client/surface.json: every method the
 * table lists is called as each of its cases states, and what the call did
 * first is held to the row. A row with no call here fails, and so does a call
 * here with no row: the table and this SDK list the same methods.
 */
class SurfaceTest {
    private val table = Spec.read("client/surface.json").jsonObject
    private val fixtures = table.getValue("fixtures").jsonObject

    /** What a row says of this SDK: whether it lacks the method, or is still to have it. */
    private fun JsonObject.namesKotlinIn(key: String) = "kotlin" in (this[key]?.jsonObject ?: JsonObject(emptyMap()))

    /** Each method the table says this SDK has, with its row. */
    private val rows: Map<String, JsonObject> = table.getValue("namespaces").jsonArray.map { it.jsonObject }
        .filterNot { it.namesKotlinIn("notYetReached") }
        .flatMap { namespace ->
            namespace.getValue("methods").jsonArray.map { it.jsonObject }
                .filterNot { it.namesKotlinIn("absent") || it.namesKotlinIn("notYetReached") }
                .map { row -> "${namespace.getValue("namespace").jsonPrimitive.content}.${row.getValue("method").jsonPrimitive.content}" to row }
        }.toMap()

    @Test
    fun theTableAndThisSdkListTheSameMethods() {
        assertEquals(rows.keys, calls.keys)
    }

    @TestFactory
    fun eachCaseDoesWhatItsRowSays(): List<DynamicTest> = rows.flatMap { (method, row) ->
        val (route, name) = row.getValue("via").jsonObject.entries.single().let { it.key to it.value.jsonPrimitive.content }
        row.getValue("cases").jsonArray.map { it.jsonObject }.mapIndexed { index, case ->
            DynamicTest.dynamicTest("$method ${case["why"]?.jsonPrimitive?.content ?: "#${index + 1}"}") {
                held(method, Step(route, name, resolved(case.getValue("sends"), fixtures).jsonObject), Args(case.getValue("args").jsonObject, fixtures), case)
            }
        }
    }

    /** One thing a call does: through which route, to what, with what. */
    private data class Step(val route: String, val name: String, val sends: JsonObject)

    /** The steps a case states after its first, each as its row's `via` is stated. */
    private fun thenOf(case: JsonObject): List<Step> = case["then"]?.jsonArray.orEmpty().map { it.jsonObject }.map { step ->
        val (route, name) = step.entries.single { it.key != "sends" }.let { it.key to it.value.jsonPrimitive.content }
        Step(route, name, resolved(step.getValue("sends"), fixtures).jsonObject)
    }

    private fun held(method: String, first: Step, args: Args, case: JsonObject) = runBlocking {
        val (route, name, sends) = first
        val recording = Recording()
        SemiontClient(recording, recording, recording).use { client ->
            val call = calls.getValue(method)
            when (route) {
                "local" -> {
                    val heard = client.bus.framesOn(name, null)
                    call(client, args)
                    val frame = withTimeout(5_000) { heard.first() }
                    assertTrue(sameJson(sends, frame.payload), "published ${frame.payload}, not $sends")
                }
                "observes" -> {
                    val reading = call(client, args) as Typed<*>
                    client.bus.emit(name, sends, null, null)
                    val delivered = withTimeout(5_000) { reading.first() }
                    // What the reader handed over is what the case's payload is as its channel's type.
                    assertEquals(decoded(channelNamed(name), sends), delivered.payload)
                }
                else -> {
                    case["answers"]?.let { recording.answer(name, resolved(it, fixtures)) }
                    val running = launch(Dispatchers.Default) { call(client, args) }
                    for ((at, step) in (listOf(first) + thenOf(case)).withIndex()) {
                        withTimeout(5_000) { while (recording.did.size <= at) delay(5) }
                        val did = recording.did[at]
                        // A request is an emit on its operation's request channel, as a drive is on its own.
                        val expected = if (step.route == "request" || step.route == "emit") "emit" else step.route
                        assertEquals(expected to step.name, did.route to did.name)
                        assertTrue(sameJson(step.sends, did.sends), "sent ${did.sends}, not ${step.sends}")
                    }
                    running.cancel()
                }
            }
        }
    }
}
