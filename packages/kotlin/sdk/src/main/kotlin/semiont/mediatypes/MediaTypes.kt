package semiont.mediatypes

/*
 * The rules read from the media types a knowledge base admits, as every SDK
 * reads them (specs/src/media-types/cases.json): the format a clone takes,
 * the name content is stored under, and where a type's text comes from, with
 * what follows from that. The table is media-types/registry.json's.
 */

private val BY_MEDIA_TYPE: Map<String, MediaType> = MEDIA_TYPES.associateBy { it.mediaType }

private val PLAIN_TEXT: MediaType = BY_MEDIA_TYPE.getValue("text/plain")

/** A format without its parameters (`; charset=…`), in lower case. */
internal fun baseMediaType(format: String): String = format.substringBefore(';').trim().lowercase()

/** The registry's row for `format`, whose parameters are not read. A stored type may be one the registry lacks: what was imported keeps the type it came with. */
internal fun capabilitiesOf(format: String): MediaType? = BY_MEDIA_TYPE[baseMediaType(format)]

/** The format a clone of a resource takes: its source's, when that is one a person can author, and plain text otherwise. A clone opens where a person writes. */
internal fun cloneFormat(source: String?): MediaType = source?.let(::capabilitiesOf)?.takeIf { it.authorable } ?: PLAIN_TEXT

/**
 * The name a resource's content is stored under: its title in lower case,
 * every run of characters that are not a to z or 0 to 9 made one hyphen, none
 * at either end, and then the format's extension.
 */
internal fun storageFileName(name: String, format: MediaType): String = buildString {
    for (character in name.lowercase()) {
        if (character in 'a'..'z' || character in '0'..'9') {
            append(character)
        } else if (isEmpty() || last() != '-') {
            append('-')
        }
    }
}.trim('-') + format.extension

/** The `file://` URI of `storageFileName`: where the content is stored, at the root of the working tree. */
internal fun storageUri(name: String, format: MediaType): String = "file://${storageFileName(name, format)}"

/**
 * Where the text of a resource of `format` comes from. A type the registry has
 * answers as its row says. One it lacks is decoded when it is a `text/` type,
 * which is text by what the type says of itself, and has no text otherwise.
 */
internal fun textSourceOf(format: String): TextSource =
    capabilitiesOf(format)?.textSource ?: if (baseMediaType(format).startsWith("text/")) TextSource.Decode else TextSource.None

/** Whether the text of a resource of `format` comes with where each run of it is on a page: a text read out of a PDF does, and one decoded from its bytes does not. */
internal fun yieldsGeometryOf(format: String): Boolean = when (textSourceOf(format)) {
    TextSource.PdfTextLayer -> true
    TextSource.Decode, TextSource.None -> false
}

/**
 * Whether the text of a resource of `format` is derived from its bytes, and
 * not decoded from them. Another question than `yieldsGeometryOf`, though no
 * text source yet answers the two differently: a text transcribed from a
 * recording would be derived, and on no page.
 */
internal fun derivesTextOf(format: String): Boolean = when (textSourceOf(format)) {
    TextSource.PdfTextLayer -> true
    TextSource.Decode, TextSource.None -> false
}
