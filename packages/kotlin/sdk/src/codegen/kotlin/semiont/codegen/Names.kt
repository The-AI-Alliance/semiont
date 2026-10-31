package semiont.codegen

/** `in-process` and `subjectClaim` as `InProcess` and `SubjectClaim`. */
internal fun pascal(word: String): String {
    val out = StringBuilder()
    var upper = true
    for (c in word) {
        if (c.isAsciiLetterOrDigit()) {
            out.append(if (upper) c.uppercaseChar() else c)
            upper = false
        } else {
            upper = true
        }
    }
    return out.toString()
}

private fun Char.isAsciiLetterOrDigit(): Boolean = this in 'a'..'z' || this in 'A'..'Z' || this in '0'..'9'

/** Kotlin's hard keywords: a name that is one is written in backquotes. */
private val KEYWORDS = setOf(
    "as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in", "interface", "is",
    "null", "object", "package", "return", "super", "this", "throw", "true", "try", "typealias", "typeof",
    "val", "var", "when", "while",
)

/**
 * A property's Kotlin name, from the name the wire gives it: JSON-LD's `@`
 * and a stamp's leading `_` dropped, and a word that a `_` or `-` begins
 * capitalised (`_userId` → `userId`, `email_sha1` → `emailSha1`).
 */
internal fun propertyName(wire: String): String {
    val pascal = pascal(wire.trimStart('@', '_'))
    if (pascal.isEmpty() || pascal[0].isDigit()) refuse("the property `$wire` has no Kotlin name: it must begin with a letter once its `@` or `_` is dropped")
    return pascal[0].lowercaseChar() + pascal.substring(1)
}

/** A name as it is written in code: backquoted when it is a keyword. */
internal fun code(name: String): String = if (name in KEYWORDS) "`$name`" else name

/** The constant an enumeration's value is. A `+` is part of what a value says (`text/x-c++` is not `text/x-c`), so it is spelled. */
internal fun variantOf(value: String): String {
    val variant = pascal(value.replace("+", " plus "))
    if (variant.isEmpty() || variant[0].isDigit()) refuse("the enumeration value `$value` has no Kotlin name: it must begin with a letter")
    return variant
}

/** `text` as a Kotlin string literal. */
internal fun literal(text: String): String = buildString {
    append('"')
    for (c in text) {
        when (c) {
            '\\' -> append("\\\\")
            '"' -> append("\\\"")
            '$' -> append("\\$")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (c < ' ') append("\\u%04x".format(c.code)) else append(c)
        }
    }
    append('"')
}

/** A schema's description as a KDoc comment, indented. A block comment nests in Kotlin, so neither `/*` nor `*/` is written as itself. */
internal fun kdoc(indent: String, description: String?): String {
    if (description.isNullOrBlank()) return ""
    val lines = description.replace("*/", "*&#47;").replace("/*", "&#47;*").trimEnd().lines()
    return buildString {
        append("$indent/**\n")
        for (line in lines) append(if (line.isBlank()) "$indent *\n" else "$indent * $line\n")
        append("$indent */\n")
    }
}
