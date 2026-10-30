package semiont.conformance

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.serializer
import semiont.types.Annotation
import semiont.types.FailureClass
import semiont.types.JobFilter
import semiont.types.JobParams
import semiont.types.JobProgress
import semiont.types.MarkJobResult
import semiont.types.UnitCursor
import semiont.types.YieldJobResult

/**
 * What a case states, read as the SDK's types, and what the SDK holds,
 * written as the wire writes it: the worker driver's JSON, which it reads
 * here so that every call it makes of the SDK is Java's. A value the type
 * refuses is the suite's mistake.
 */
public object Stated {
    private fun <T> read(name: String, serializer: KSerializer<T>, value: JsonElement): T = try {
        wire.decodeFromJsonElement(serializer, value)
    } catch (refused: SerializationException) {
        throw Misuse("$name: ${refused.message}")
    } catch (refused: IllegalArgumentException) {
        throw Misuse("$name: ${refused.message}")
    }

    @JvmStatic
    public fun filters(value: JsonElement): List<JobFilter> = read("accepts", ListSerializer(serializer<JobFilter>()), value)

    @JvmStatic
    public fun progress(value: JsonElement): JobProgress = read("progress", JobProgress.serializer(), value)

    @JvmStatic
    public fun cursors(value: JsonElement): Map<String, UnitCursor> = read("unitCursors", MapSerializer(String.serializer(), UnitCursor.serializer()), value)

    @JvmStatic
    public fun annotations(value: JsonElement): List<Annotation> = read("annotations", ListSerializer(Annotation.serializer()), value)

    @JvmStatic
    public fun markResult(value: JsonElement): MarkJobResult = read("result", serializer<MarkJobResult>(), value)

    @JvmStatic
    public fun yieldResult(value: JsonElement): YieldJobResult = read("result", serializer<YieldJobResult>(), value)

    @JvmStatic
    public fun failureClass(value: JsonElement): FailureClass = read("failureClass", FailureClass.serializer(), value)

    @JvmStatic
    public fun written(params: JobParams): JsonElement = wire.encodeToJsonElement(JobParams.serializer(), params)

    @JvmStatic
    public fun written(cursors: Map<String, UnitCursor>): JsonElement = wire.encodeToJsonElement(MapSerializer(String.serializer(), UnitCursor.serializer()), cursors)
}
