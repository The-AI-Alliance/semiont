package semiont.codegen

/**
 * A kind of id's pattern, as the check that holds a value to it. The patterns
 * it knows are the ones the kinds use: anchored at both ends, text every value
 * begins with, and then one set of characters a stated number of times,
 * counted in code points. Anything else is refused, and the build fails.
 */
internal class Rule private constructor(
    private val prefix: String,
    /** The code points admitted after the prefix, as a predicate over `c`. */
    private val admitted: String,
    private val least: Int,
    private val most: Int?,
) {
    companion object {
        fun of(kind: String, pattern: String): Rule {
            fun cannot(): Nothing = refuse("$kind: a pattern the generator cannot write as a check: $pattern")
            val body = pattern.removePrefix("^").removeSuffix("$")
            if (body.length != pattern.length - 2) cannot()
            val setAt = body.indexOfFirst { it == '[' || it == '\\' }
            if (setAt < 0) cannot()
            val prefix = body.substring(0, setAt)
            if (prefix.any { it in ".|?*+(){}^$]" }) cannot()
            val rest = body.substring(setAt)
            val (admitted, times) = if (rest.startsWith("\\S")) {
                "!isWhitespace(c)" to rest.removePrefix("\\S")
            } else {
                if (!rest.startsWith("[") || !rest.contains(']')) cannot()
                (set(rest.substring(1, rest.indexOf(']'))) ?: cannot()) to rest.substring(rest.indexOf(']') + 1)
            }
            val (least, most) = when {
                times == "+" -> 1 to null
                times == "*" -> 0 to null
                times.startsWith("{") && times.endsWith("}") -> {
                    val bounds = times.substring(1, times.length - 1)
                    if (bounds.contains(',')) {
                        val (low, high) = bounds.split(',', limit = 2)
                        val most: Int? = if (high.isEmpty()) null else high.toIntOrNull() ?: cannot()
                        (low.toIntOrNull() ?: cannot()) to most
                    } else {
                        val exactly = bounds.toIntOrNull() ?: cannot()
                        exactly to exactly
                    }
                }
                else -> cannot()
            }
            return Rule(prefix, admitted, least, most)
        }

        /** A character set (`A-Za-z0-9_-`) as a predicate over `c`: ranges and single characters, a `-` at either end being itself. */
        private fun set(set: String): String? {
            if (set.isEmpty() || set.startsWith("^") || set.any { it == '\\' || it == '[' || it == '\'' }) return null
            val arms = mutableListOf<String>()
            var at = 0
            while (at < set.length) {
                if (at + 2 < set.length && set[at + 1] == '-') {
                    arms += "c in '${set[at]}'.code..'${set[at + 2]}'.code"
                    at += 3
                } else {
                    arms += "c == '${set[at]}'.code"
                    at += 1
                }
            }
            return arms.joinToString(" || ")
        }
    }

    /** The body of `admits(value: String): Boolean`, indented for a companion's function. */
    fun check(): String = buildString {
        val subject = if (prefix.isEmpty()) "value" else "rest"
        if (prefix.isNotEmpty()) {
            append("            if (!value.startsWith(${literal(prefix)})) return false\n")
            append("            val rest = value.substring(${prefix.length})\n")
        }
        val count = "$subject.codePointCount(0, $subject.length)"
        val counted = when {
            least == 0 && most == null -> null
            most == null -> "$count >= $least"
            else -> "$count in $least..$most"
        }
        val all = "$subject.codePoints().allMatch { c -> $admitted }"
        append("            return ${listOfNotNull(counted, all).joinToString(" && ")}\n")
    }
}
