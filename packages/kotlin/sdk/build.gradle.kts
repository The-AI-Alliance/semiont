import org.jetbrains.kotlin.gradle.dsl.abi.ExperimentalAbiValidation
import java.io.ByteArrayOutputStream
import javax.inject.Inject
import javax.tools.ToolProvider

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    jacoco
}

kotlin {
    explicitApi()
    jvmToolchain(providers.fileContents(layout.projectDirectory.file(".java-version")).asText.get().trim().toInt())
    compilerOptions {
        // An unchecked cast is a warning, so it is an error here, and only a
        // @Suppress could let one through: the census holds those at none.
        allWarningsAsErrors = true
    }
    // The dump holds the API written by hand: the protocol's types are the
    // spec's, generated from it, and a change to the spec changes them.
    @OptIn(ExperimentalAbiValidation::class)
    abiValidation {
        filters {
            exclude {
                byNames.addAll("semiont.types.**", "semiont.identifiers.**")
            }
        }
    }
}

tasks.withType<JavaCompile>().configureEach {
    options.compilerArgs.addAll(listOf("-Xlint:all", "-Werror"))
}

dependencyLocking {
    lockAllConfigurations()
}

// The generator of the SDK's protocol types: Kotlin of its own, compiled
// first and run over specs/src, whose output is compiled with the SDK's own
// sources. Nothing it writes is committed.
val codegen: SourceSet = sourceSets.create("codegen")
val generated = layout.buildDirectory.dir("generated/semiont/main/kotlin")
val generate = tasks.register<JavaExec>("generate") {
    description = "Writes the SDK's protocol types from specs/src."
    group = LifecycleBasePlugin.BUILD_GROUP
    val specs = layout.projectDirectory.dir("../../../specs/src")
    inputs.dir(specs).withPathSensitivity(PathSensitivity.RELATIVE)
    outputs.dir(generated)
    classpath = codegen.runtimeClasspath
    mainClass = "semiont.codegen.GenerateKt"
    args(specs.asFile.path, generated.get().asFile.path)
}
kotlin.sourceSets.named("main") {
    kotlin.srcDir(generate)
}
// The generator's tests read what is internal to it.
kotlin.target.compilations.named("test") {
    associateWith(kotlin.target.compilations.getByName("codegen"))
}

// The SDK as a Java program calls it: Java alone, over the SDK's classes and
// the Kotlin tests' dependencies.
val javaTest: SourceSet = sourceSets.create("javaTest") {
    compileClasspath += sourceSets.main.get().output
    runtimeClasspath += sourceSets.main.get().output
}
kotlin.sourceSets.named("javaTest") {
    kotlin.setSrcDirs(emptyList<File>())
}
configurations.named(javaTest.implementationConfigurationName) { extendsFrom(configurations.testImplementation.get()) }
configurations.named(javaTest.runtimeOnlyConfigurationName) { extendsFrom(configurations.testRuntimeOnly.get()) }

dependencies {
    implementation(libs.kotlinx.serialization.json)
    "codegenImplementation"(libs.kotlinx.serialization.json)
    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
}

val javaTestRun = tasks.register<Test>("javaTest") {
    description = "Runs the Java tests: the SDK as a Java program calls it."
    group = LifecycleBasePlugin.VERIFICATION_GROUP
    testClassesDirs = javaTest.output.classesDirs
    classpath = javaTest.runtimeClasspath
}

jacoco {
    toolVersion = libs.versions.jacoco.get()
}

tasks.jacocoTestReport {
    executionData(tasks.test, javaTestRun)
    reports {
        xml.required = true
    }
}

/**
 * What the sources may not say. `@Suppress` (Kotlin) and `@SuppressWarnings`
 * (Java) appear nowhere: every warning is an error, so a suppression is the
 * one way an unchecked cast gets in. The SDK reads no environment variable
 * but the bus log's, `SEMIONT_BUS_LOG`. The Java tests are Java.
 */
abstract class Census : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sources: ConfigurableFileTree

    @get:OutputFile
    abstract val report: RegularFileProperty

    @TaskAction
    fun census() {
        val failures = mutableListOf<String>()
        val read = sources.files.sorted()
        for (file in read) {
            val path = file.relativeTo(sources.dir).invariantSeparatorsPath
            val text = file.readText()
            text.lines().forEachIndexed { index, line ->
                val at = "$path:${index + 1}"
                if (Regex("""@(?:file:)?Suppress(?:Warnings)?\b""").containsMatchIn(line)) {
                    failures += "$at suppresses a warning: every warning is an error, so fix what it warns of"
                }
                if (path.startsWith("main/")) {
                    for (read in Regex("""\bgetenv\s*\(([^)]*)\)""").findAll(line)) {
                        if (read.groupValues[1].trim() != "\"SEMIONT_BUS_LOG\"") {
                            failures += "$at reads the environment (${read.value}): the SDK reads SEMIONT_BUS_LOG and nothing else, and is handed the rest by the application"
                        }
                    }
                }
            }
            if (path.startsWith("javaTest/") && !path.endsWith(".java")) {
                failures += "$path is in the Java tests and is not Java"
            }
        }
        if (failures.isNotEmpty()) throw GradleException("census — ${failures.size} problem(s):\n  " + failures.joinToString("\n  "))
        report.get().asFile.writeText("${read.size} files read\n")
        logger.lifecycle("census: ${read.size} files under src/, none suppressing a warning, and the SDK reading no environment variable but SEMIONT_BUS_LOG")
    }
}

val census = tasks.register<Census>("census") {
    description = "Holds the sources to what they may not say."
    group = LifecycleBasePlugin.VERIFICATION_GROUP
    sources.from(layout.projectDirectory.dir("src"))
    report = layout.buildDirectory.file("census.txt")
}

/**
 * Programs that must not compile against the SDK: each Kotlin file under
 * src/refusals/kotlin and each Java file under src/refusals/java. A refusal's
 * first line is `// refused: <text>`, and the compiler must refuse it with a
 * message holding that text: a program refused for another reason proves
 * nothing.
 */
abstract class Refusals : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val refusals: ConfigurableFileTree

    @get:Classpath
    abstract val against: ConfigurableFileCollection

    @get:Classpath
    abstract val compiler: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val scratch: DirectoryProperty

    @get:Inject
    abstract val exec: ExecOperations

    @TaskAction
    fun refuse() {
        // An entry that does not exist (the classes of an SDK with none yet)
        // is a warning, and every warning refuses.
        val classpath = against.filter { it.exists() }.asPath
        val failures = mutableListOf<String>()
        val programs = refusals.files.sorted()
        for (program in programs) {
            val path = program.relativeTo(refusals.dir).invariantSeparatorsPath
            val expected = Regex("""^// refused: (.+)$""").find(program.readLines().firstOrNull().orEmpty())?.groupValues?.get(1)
            if (expected == null) {
                failures += "$path does not begin with `// refused: <text>`, the message it is to be refused with"
                continue
            }
            val out = scratch.get().dir(path).asFile.apply { deleteRecursively(); mkdirs() }
            val (refused, said) = when (program.extension) {
                "kt" -> kotlinc(program, classpath, out)
                "java" -> javac(program, classpath, out)
                else -> {
                    failures += "$path is neither Kotlin nor Java"
                    continue
                }
            }
            if (!refused) failures += "$path compiles, and is to be refused with: $expected"
            else if (!said.contains(expected)) failures += "$path is refused, and not with \"$expected\":\n    ${said.trim().replace("\n", "\n    ")}"
        }
        if (failures.isNotEmpty()) throw GradleException("refusals — ${failures.size} problem(s):\n  " + failures.joinToString("\n  "))
        logger.lifecycle("refusals: ${programs.size} programs, each refused with the message it states")
    }

    private fun kotlinc(program: File, classpath: String, out: File): Pair<Boolean, String> {
        val said = ByteArrayOutputStream()
        val result = exec.javaexec {
            classpath(compiler)
            mainClass = "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler"
            // What the compiler's own JVM says of itself is no part of a refusal.
            jvmArgs("--enable-native-access=ALL-UNNAMED", "--sun-misc-unsafe-memory-access=allow")
            args("-no-stdlib", "-no-reflect", "-Werror", "-classpath", classpath, "-d", out.path, program.path)
            standardOutput = said
            errorOutput = said
            isIgnoreExitValue = true
        }
        return (result.exitValue != 0) to said.toString()
    }

    private fun javac(program: File, classpath: String, out: File): Pair<Boolean, String> {
        val said = ByteArrayOutputStream()
        val status = ToolProvider.getSystemJavaCompiler()
            .run(null, said, said, "-Xlint:all", "-Werror", "-classpath", classpath, "-d", out.path, program.path)
        return (status != 0) to said.toString()
    }
}

val refusals = tasks.register<Refusals>("refusals") {
    description = "Compiles each program that must not compile against the SDK, and expects its refusal."
    group = LifecycleBasePlugin.VERIFICATION_GROUP
    refusals.from(layout.projectDirectory.dir("src/refusals"))
    against.from(sourceSets.main.map { it.output }, configurations.runtimeClasspath)
    compiler.from(configurations.named("kotlinCompilerClasspath"))
    scratch = layout.buildDirectory.dir("refusals")
}

tasks.check {
    dependsOn(javaTestRun, census, refusals, tasks.jacocoTestReport)
}
