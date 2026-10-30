package semiont.annotations

/*
 * A text as the case tables under specs/src count it. An offset counts Unicode
 * code points from the start of a text, and so does every length a rule
 * states, where a Kotlin string counts UTF-16 units: so a text is worked on as
 * its code points, an offset is an index into them, and a string is made only
 * of what is handed back.
 */

/** A text's code points. */
internal fun codePointsOf(text: String): IntArray = text.codePoints().toArray()

/** The code points from `start` up to but not including `end`, as a string. */
internal fun IntArray.text(start: Int = 0, end: Int = size): String = String(this, start, end - start)

/** Whether the code points at `at` are `words`. */
internal fun IntArray.hasAt(at: Int, words: IntArray): Boolean =
    at >= 0 && at + words.size <= size && words.indices.all { this[at + it] == words[it] }

/** The first place at or after `from` that has `words`, or -1. */
internal fun IntArray.indexOf(words: IntArray, from: Int = 0): Int {
    for (at in from.coerceAtLeast(0)..size - words.size) if (hasAt(at, words)) return at
    return -1
}

/** Whether `words` is anywhere in these code points. */
internal operator fun IntArray.contains(words: IntArray): Boolean = indexOf(words) >= 0

/**
 * The twenty-five characters with Unicode's White_Space property: white space
 * as the case tables count it. Neither Kotlin's `isWhitespace` nor a regex's
 * `\s` is that set.
 */
internal val WHITE_SPACE: Set<Int> = buildSet {
    addAll(0x0009..0x000d)
    addAll(listOf(0x0020, 0x0085, 0x00a0, 0x1680))
    addAll(0x2000..0x200a)
    addAll(listOf(0x2028, 0x2029, 0x202f, 0x205f, 0x3000))
}

/** `text` without the white space at its two ends. */
internal fun trimmed(text: String): String = text.trim { it.code in WHITE_SPACE }

/** `text` with every run of white space made one space, and none at its two ends. */
internal fun collapsed(text: String): String = buildString {
    var inRun = false
    for (c in trimmed(text)) {
        if (c.code in WHITE_SPACE) {
            if (!inRun) append(' ')
            inRun = true
        } else {
            append(c)
            inRun = false
        }
    }
}
