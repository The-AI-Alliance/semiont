package semiont.annotations

/*
 * A span of a text, and finding the one a model quoted. A model asked to mark
 * a text quotes it, and nothing it says is trusted: `reconcile` finds the
 * quoted words in the text and answers a span that is the text's own, or
 * nothing (specs/src/annotations/reconcile-cases.json).
 */

/**
 * The words a model quoted from a text, and what it says stands beside them.
 * `prefix` and `suffix` are hints of which place is meant, where the text has
 * the words in more than one. Neither is kept: a span's context is the text's.
 */
public data class QuotedText @JvmOverloads constructor(
    public val exact: String,
    public val prefix: String? = null,
    public val suffix: String? = null,
)

/**
 * A span of a text: the code points from `start` up to but not including
 * `end`. `exact` is the words there, and `prefix` and `suffix` what the text
 * has just before and just after them.
 */
public data class TextSpan @JvmOverloads constructor(
    public val start: Long,
    public val end: Long,
    public val exact: String,
    public val prefix: String? = null,
    public val suffix: String? = null,
)

/** Which looser search found a span. */
public enum class MatchQuality(
    /** The value as the tables spell it. */
    public val value: String,
) {
    /** Without regard to white space, or to the forms of quotation marks and dashes. */
    Normalized("normalized"),

    /** Without regard to letter case. */
    CaseInsensitive("case-insensitive"),

    /** Within a twentieth of the words' length in edits. */
    Fuzzy("fuzzy"),
}

/** How a span was found. */
public sealed interface AnchorMethod {
    /** The value as the tables spell it. */
    public val value: String

    /** The text has the words in exactly one place. */
    public data object UniqueMatch : AnchorMethod {
        override val value: String get() = "unique-match"
    }

    /** The text has them in several, and what the model said stands around them chose this one. */
    public data object ContextRecovered : AnchorMethod {
        override val value: String get() = "context-recovered"
    }

    /** The text has them in several and nothing chose among them: this is the first, and may not be the one the model meant. */
    public data object FirstOfMany : AnchorMethod {
        override val value: String get() = "first-of-many"
    }

    /** The text does not have them character for character, and a looser search, `quality`, found them. */
    public data class FuzzyMatch(public val quality: MatchQuality) : AnchorMethod {
        override val value: String get() = "fuzzy-match"
    }
}

/** A span `reconcile` found, which is the text's own, and how it was found. */
public data class ReconciledSpan(public val span: TextSpan, public val anchorMethod: AnchorMethod)

/** How many code points of the text a prefix or a suffix is. */
private const val CONTEXT = 64

/** How many more it may take to begin or end at a boundary. */
private const val LENGTHENED_BY_AT_MOST = 32

/** What a context is not lengthened past: white space, or one of eighteen marks. */
private val BOUNDARY: Set<Int> = WHITE_SPACE + ".,;:!?'\"()[]{}<>/\\".map { it.code }

/** The least number of code points beside a place that a hint is looked for in. */
private const val HINT_REACH = 32

/** The plain form of each quotation mark and dash that has one. */
private val PLAIN: Map<Int, String> = mapOf(0x2018 to "'", 0x2019 to "'", 0x201c to "\"", 0x201d to "\"", 0x2014 to "--", 0x2013 to "-")

/** The loose search allows one edit for each this many code points of the quote. */
private const val ALLOWED_EDITS_ONE_IN = 20

/** A span of the text as its two offsets. */
private typealias Place = Pair<Int, Int>

/** Every place `text` has `words`, as the offset each starts at, in the text's order. Places may overlap. */
internal fun places(text: IntArray, words: IntArray): List<Int> {
    val found = mutableListOf<Int>()
    var at = text.indexOf(words)
    while (at != -1) {
        found += at
        at = text.indexOf(words, at + 1)
    }
    return found
}

/** The text just before a place and just after it: nothing on a side where the text has nothing. */
private fun contextOf(text: IntArray, place: Place): Pair<String?, String?> {
    val (start, end) = place
    var prefix: String? = null
    if (start > 0) {
        var begins = maxOf(0, start - CONTEXT)
        val furthest = maxOf(0, begins - LENGTHENED_BY_AT_MOST)
        while (begins > furthest && text[begins - 1] !in BOUNDARY) begins -= 1
        prefix = text.text(begins, start)
    }
    var suffix: String? = null
    if (end < text.size) {
        var ends = minOf(text.size, end + CONTEXT)
        val furthest = minOf(text.size, ends + LENGTHENED_BY_AT_MOST)
        while (ends < furthest && text[ends] !in BOUNDARY) ends += 1
        suffix = text.text(end, ends)
    }
    return prefix to suffix
}

/** A text changed for a looser search, and for each code point of it the offset in the text of the character it came from. */
private class Changed(val points: IntArray, val cameFrom: IntArray)

/**
 * `text` normalized: every run of white space one space, counted from where
 * the run began, none at the two ends, and a quotation mark or a dash its
 * plain form. An em dash is two hyphens, and both came from the dash.
 */
private fun normalized(text: IntArray): Changed {
    val written = mutableListOf<Int>()
    val cameFrom = mutableListOf<Int>()
    var runBegan: Int? = null
    for ((offset, character) in text.withIndex()) {
        if (character in WHITE_SPACE) {
            if (runBegan == null) runBegan = offset
            continue
        }
        if (runBegan != null) {
            if (written.isNotEmpty()) {
                written += ' '.code
                cameFrom += runBegan
            }
            runBegan = null
        }
        val plain = PLAIN[character]?.let(::codePointsOf) ?: intArrayOf(character)
        for (point in plain) {
            written += point
            cameFrom += offset
        }
    }
    return Changed(written.toIntArray(), cameFrom.toIntArray())
}

/**
 * `text` in lower case, by Unicode's rule of no language, lower-cased whole: a
 * capital sigma that ends a word becomes the final one, which a character at a
 * time would miss. A character becomes as many code points whole as alone (a
 * capital I with a dot becomes two), and that is what the offsets count from.
 */
private fun lowerCased(text: IntArray): Changed {
    val lowered = codePointsOf(text.text().lowercase())
    val cameFrom = text.withIndex().flatMap { (offset, character) -> List(codePointsOf(intArrayOf(character).text().lowercase()).size) { offset } }
    check(cameFrom.size == lowered.size) { "a text lower-cased whole is not as long as its characters lower-cased one at a time" }
    return Changed(lowered, cameFrom.toIntArray())
}

/**
 * The places of the text that matches in a changed copy of it came from, each
 * `length` code points of the copy: from the character its first code point
 * came from to just after the one its last came from.
 */
private fun cameFrom(changed: Changed, found: List<Int>, length: Int): List<Place> =
    found.map { at -> changed.cameFrom[at] to changed.cameFrom[at + length - 1] + 1 }

/**
 * The edit distance from `wanted` to each stretch of `text` at `start` that is
 * within `allowance` of it in length: the distance to the stretch of
 * `wanted.size - allowance + n` code points is at `[n]`. Nothing when no
 * stretch from `start` is within the allowance. Of each row of the table of
 * distances only the stretches near in length to what of `wanted` has been
 * taken can be within the allowance, and only those are worked out; a distance
 * beyond the allowance is held as one more than it.
 */
private fun distancesFrom(wanted: IntArray, text: IntArray, start: Int, longest: Int, allowance: Int): IntArray? {
    val beyond = allowance + 1
    // After `taken` code points of `wanted`, the stretch of `length` is at [length - taken + allowance + 1]; the two ends stay beyond.
    val width = 2 * allowance + 3
    var row = IntArray(width) { beyond }
    for (length in 0..minOf(allowance, longest)) row[length + allowance + 1] = length
    for (taken in 1..wanted.size) {
        val above = row
        row = IntArray(width) { beyond }
        val letter = wanted[taken - 1]
        var least = beyond
        for (length in maxOf(0, taken - allowance)..minOf(longest, taken + allowance)) {
            val at = length - taken + allowance + 1
            // Against no text at all, every code point taken is one deleted.
            val distance = if (length == 0) {
                taken
            } else {
                val replaced = if (letter == text[start + length - 1]) 0 else 1
                minOf(above[at + 1] + 1, row[at - 1] + 1, above[at] + replaced, beyond)
            }
            row[at] = distance
            least = minOf(least, distance)
        }
        // The least distance of a row never falls as more of `wanted` is taken.
        if (least > allowance) return null
    }
    return row.copyOfRange(1, width - 1)
}

/**
 * The stretch of `text` at the least edit distance from `exact`, when that is
 * within the allowance: a twentieth of `exact`'s code points, rounded down,
 * with no minimum. Of several at the least distance it is the first in the
 * text; of those that begin at one place, the nearest `exact` in length; and
 * of two as near, the shorter.
 */
internal fun nearestStretch(text: IntArray, exact: IntArray): Pair<Int, Int>? {
    val size = exact.size
    val allowance = size / ALLOWED_EDITS_ONE_IN
    // A stretch at no distance is `exact` itself, which the text was searched for before this.
    if (allowance == 0) return null
    // From each start: the stretch as long as `exact`, then a code point shorter, a code point longer, and so on out.
    val nearestInLengthFirst = listOf(size) + (1..allowance).flatMap { away -> listOf(size - away, size + away) }
    var best: Pair<Int, Place>? = null
    for (start in 0..text.size - (size - allowance)) {
        val distances = distancesFrom(exact, text, start, minOf(size + allowance, text.size - start), allowance) ?: continue
        for (length in nearestInLengthFirst) {
            val distance = distances[length - size + allowance]
            if (distance <= allowance && (best == null || distance < best.first)) best = distance to (start to start + length)
        }
    }
    return best?.second
}

/** The places the first looser search that finds any finds, in the text's order, and which search it was. */
internal fun looser(text: IntArray, exact: String): Pair<List<Place>, MatchQuality>? {
    val normal = normalized(text)
    val wanted = normalized(codePointsOf(exact)).points
    places(normal.points, wanted).takeIf { it.isNotEmpty() }?.let { return cameFrom(normal, it, wanted.size) to MatchQuality.Normalized }

    val lowered = lowerCased(text)
    val lowerWanted = codePointsOf(exact.lowercase())
    places(lowered.points, lowerWanted).takeIf { it.isNotEmpty() }?.let { return cameFrom(lowered, it, lowerWanted.size) to MatchQuality.CaseInsensitive }

    return nearestStretch(text, codePointsOf(exact))?.let { listOf(it) to MatchQuality.Fuzzy }
}

/** What a model says stands beside the words, when it is more than white space: a hint of where. */
internal fun hint(given: String?): String? = given?.takeIf { trimmed(it).isNotEmpty() }

/**
 * Whether the text around a place carries every hint given. A hint is looked
 * for in as many code points beside the place as the hint has, and at least
 * `HINT_REACH`; it fits when the text there has it anywhere, the white space
 * at the hint's own two ends removed.
 */
private fun fits(text: IntArray, place: Place, prefix: String?, suffix: String?): Boolean {
    val (start, end) = place
    if (prefix != null) {
        val reach = maxOf(HINT_REACH, codePointsOf(prefix).size)
        if (codePointsOf(trimmed(prefix)) !in text.copyOfRange(maxOf(0, start - reach), start)) return false
    }
    if (suffix == null) return true
    val reach = maxOf(HINT_REACH, codePointsOf(suffix).size)
    return codePointsOf(trimmed(suffix)) in text.copyOfRange(end, minOf(text.size, end + reach))
}

/** The first of several places that fits every hint given. Nothing when no hint was given, and when no place fits. */
internal fun hinted(text: IntArray, found: List<Place>, prefix: String?, suffix: String?): Place? =
    if (prefix == null && suffix == null) null else found.firstOrNull { fits(text, it, prefix, suffix) }

/** A place as the span it is: its words and its context are the text's, never the model's spelling of them. */
internal fun reconciled(text: IntArray, place: Place, anchorMethod: AnchorMethod): ReconciledSpan {
    val (start, end) = place
    val (prefix, suffix) = contextOf(text, place)
    return ReconciledSpan(TextSpan(start.toLong(), end.toLong(), text.text(start, end), prefix, suffix), anchorMethod)
}
