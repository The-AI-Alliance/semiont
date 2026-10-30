package semiont.codegen

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.nio.file.Path
import kotlin.io.path.createDirectories
import kotlin.io.path.writeText

/**
 * Writes, from specs/src, what the SDK holds of the protocol: every component
 * schema of the bundled OpenAPI document as a type of `semiont.types`, each in
 * a file of its own, and the kinds of id (specs/src/identifiers/kinds.json) in
 * `semiont.identifiers`. What it writes before is gone first, so a schema the
 * spec drops leaves nothing behind.
 */
public fun main(args: Array<String>) {
    require(args.size == 2) { "usage: <specs/src> <output directory>" }
    val specs = Path.of(args[0])
    val out = Path.of(args[1])
    try {
        // The sign-in store's entry is no component of the API: it is the store's own schema, beside it.
        val signIn = readJson(specs.resolve("sign-in-store/SignIn.json")) as? JsonObject ?: refuse("sign-in-store/SignIn.json is no object")
        val components = draft7Definitions(Bundle.of(specs.resolve("openapi.json")))
        if ("SignIn" in components) refuse("the API's components name a SignIn, which is the sign-in store's")
        val stored = draft7Definitions(JsonObject(mapOf("components" to JsonObject(mapOf("schemas" to JsonObject(mapOf("SignIn" to signIn)))))))
        val definitions = JsonObject(components + stored)
        val kinds = ((readJson(specs.resolve("identifiers/kinds.json")) as? JsonObject)?.get("kinds") as? JsonArray ?: refuse("identifiers/kinds.json lists no kinds"))
            .map { ((it as? JsonObject)?.get("schema") as? JsonPrimitive)?.content ?: refuse("a kind of id names no schema: $it") }
            .toSet()
        val generated = generate(definitions, Generation(roots = definitions.keys, identifiers = kinds))
        out.toFile().deleteRecursively()
        val types = out.resolve(TYPES_PACKAGE.replace('.', '/')).createDirectories()
        for ((name, code) in generated.types) types.resolve("$name.kt").writeText(header(TYPES_PACKAGE, kinds) + code)
        out.resolve(IDENTIFIERS_PACKAGE.replace('.', '/')).createDirectories().resolve("Identifiers.kt")
            .writeText(header(IDENTIFIERS_PACKAGE, kinds) + generated.identifiers)
        val registry = readJson(specs.resolve("bus/registry.json")) as? JsonObject ?: refuse("bus/registry.json is no object")
        fun table(pkg: String, file: String, imports: List<String>, code: String) {
            val start = "// Generated from specs/src; do not edit.\n\npackage $pkg\n\n" + imports.joinToString("") { "import $it\n" } + "\n"
            out.resolve(pkg.replace('.', '/')).createDirectories().resolve(file).writeText(start + code)
        }
        table("semiont.channels", "Channels.kt", listOf("semiont.Generated", "semiont.types.*"), channelsFile(registry, definitions))
        table("semiont.bus", "Operations.kt", listOf("semiont.Generated", "semiont.channels.*", "semiont.types.*"), operationsFile(registry, definitions))
        table("semiont.bus", "Credentials.kt", emptyList(), credentialsFile(readJson(specs.resolve("bus/log-cases.json")) as? JsonObject ?: refuse("bus/log-cases.json is no object")))
        table("semiont", "Timings.kt", listOf("semiont.retry.RetryPolicy"), timingFile(readJson(specs.resolve("client/timing.json")) as? JsonObject ?: refuse("client/timing.json is no object")))
        table("semiont.telemetry", "TelemetryTable.kt", listOf("io.opentelemetry.api.trace.SpanKind"), telemetryFile(readJson(specs.resolve("sdk-telemetry/telemetry.json")) as? JsonObject ?: refuse("sdk-telemetry/telemetry.json is no object")))
        table("semiont.signin", "OAuthClients.kt", listOf("semiont.Generated"), oauthClientsFile(readJson(specs.resolve("session/oauth.json")) as? JsonObject ?: refuse("session/oauth.json is no object")))
        table("semiont.errors", "ErrorCodes.kt", listOf("semiont.Generated"), errorCodesFile(readJson(specs.resolve("errors/codes.json")) as? JsonObject ?: refuse("errors/codes.json is no object")))
        println("generated ${generated.types.size} types and ${kinds.size} kinds of id")
    } catch (refused: Refused) {
        System.err.println("the generator refuses: ${refused.message}")
        kotlin.system.exitProcess(1)
    }
}
