package semiont.conformance

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import semiont.errors.SemiontError
import semiont.errors.TransportError
import java.io.FileDescriptor
import java.io.FileOutputStream
import java.io.PrintStream

/** The suite's arguments made no sense: its mistake, never the SDK's. */
internal class Misuse(message: String) : Exception(message)

/** Every line out, one at a time and in UTF-8 whatever the locale: what settles an operation and what the client observes. */
internal object Say {
    private val out = PrintStream(FileOutputStream(FileDescriptor.out), false, Charsets.UTF_8)

    @Synchronized
    fun line(value: JsonElement) {
        out.println(value.toString())
        out.flush()
    }

    fun of(vararg pairs: Pair<String, JsonElement>): JsonObject = JsonObject(mapOf(*pairs))
}

/** A failure as the suite reads one: its code, the status a server stated, and the SDK's words. */
internal fun failure(error: SemiontError): JsonObject {
    val fields = mutableMapOf<String, JsonElement>("code" to JsonPrimitive(error.code), "detail" to JsonPrimitive(error.message ?: ""))
    if (error is TransportError) error.status?.let { fields["status"] = JsonPrimitive(it) }
    return JsonObject(fields)
}

internal fun JsonObject.text(name: String): String =
    (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw Misuse("$name must be text")

internal fun JsonObject.optionalText(name: String): String? =
    if (name !in this || this[name] is JsonNull) null else text(name)

internal fun JsonObject.texts(name: String): List<String> =
    (this[name] as? JsonArray)?.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: throw Misuse("$name must be a list of text") }
        ?: throw Misuse("$name must be a list of text")

internal fun JsonObject.count(name: String): Long =
    (this[name] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it >= 0 } ?: throw Misuse("$name must be a whole number")

internal fun JsonObject.obj(name: String): JsonObject = this[name] as? JsonObject ?: throw Misuse("$name must be an object")

/** A driver: its operations, by name, and what it does when its input ends. */
internal interface Driver {
    val operations: Set<String>

    suspend fun run(id: Long, op: String, args: JsonObject): JsonElement

    fun finish()
}

/**
 * Serve the driver protocol (tests/conformance/sdk/README.md, The driver
 * protocol): say ready, run each operation as it comes, concurrently, and
 * answer each once. An operation the driver does not have is answered at once,
 * before the next is read. `abandon` ends the operation it names, which then
 * settles as abandoned.
 */
internal fun serve(make: (abandon: (Long) -> Boolean) -> Driver) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val running = mutableMapOf<Long, Job>()
    val abandoned = mutableSetOf<Long>()
    val driver = make { id ->
        synchronized(running) {
            val job = running[id] ?: return@make false
            abandoned += id
            job.cancel()
            true
        }
    }
    Say.line(Say.of("ready" to JsonPrimitive(true)))
    val input = System.`in`.bufferedReader(Charsets.UTF_8)
    while (true) {
        val line = input.readLine() ?: break
        if (line.isBlank()) continue
        val request = try {
            Json.parseToJsonElement(line) as JsonObject
        } catch (_: Exception) {
            System.err.println("not an operation: $line")
            continue
        }
        val idValue = request["id"]
        val id = (idValue as? JsonPrimitive)?.longOrNull
        val op = (request["op"] as? JsonPrimitive)?.content
        if (id == null || op == null) {
            System.err.println("an operation with no id or op: $line")
            continue
        }
        if (op !in driver.operations) {
            Say.line(Say.of("id" to idValue, "unsupported" to JsonPrimitive(true)))
            continue
        }
        synchronized(running) {
            running[id] = scope.launch {
                val answer = try {
                    Say.of("id" to idValue, "ok" to driver.run(id, op, request))
                } catch (_: CancellationException) {
                    Say.of("id" to idValue, "abandoned" to JsonPrimitive(true))
                } catch (misuse: Misuse) {
                    Say.of("id" to idValue, "misuse" to JsonPrimitive(misuse.message ?: "misuse"))
                } catch (error: SemiontError) {
                    Say.of("id" to idValue, "error" to failure(error))
                } catch (error: Exception) {
                    System.err.println("$op failed: $error")
                    error.printStackTrace()
                    Say.of("id" to idValue, "error" to Say.of("code" to JsonPrimitive("error"), "detail" to JsonPrimitive(error.toString())))
                }
                synchronized(running) {
                    running.remove(id)
                    if (answer.containsKey("abandoned") && id !in abandoned) return@launch
                }
                Say.line(answer)
            }
        }
    }
    runBlocking {
        synchronized(running) { running.values.toList() }.forEach { it.cancel() }
    }
    driver.finish()
}
