package semiont.resources

import semiont.errors.TransportError
import semiont.errors.TransportErrorCode
import semiont.mediatypes.TextSource
import semiont.mediatypes.baseMediaType
import semiont.mediatypes.derivesTextOf
import semiont.mediatypes.textSourceOf
import java.nio.ByteBuffer
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.nio.charset.UnsupportedCharsetException

// What a content type is made of, as the MIME Sniffing Standard reads one: its white space, and the characters of a type, a
// subtype and a parameter's name.
private const val HTTP_WHITE_SPACE = "\n\r\t "
private const val HTTP_TOKEN = "!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

/** What the Encoding Standard drops from around a label. */
private const val ASCII_WHITE_SPACE = "\t\n\u000c\r "

private const val REPLACEMENT = '�'

/**
 * The standard's legacy multi-byte encodings, each by the JDK's decoder of the
 * encoding the standard names for it: GBK's is gb18030's, and each other is
 * the superset of what its name says that the standard reads (Big5-HKSCS,
 * windows-949, windows-31j). text/encoding-cases.json holds every label of each.
 */
private val LEGACY_MULTI_BYTE: Map<String, String> = mapOf(
    "big5" to "Big5-HKSCS",
    "euc-jp" to "EUC-JP",
    "euc-kr" to "x-windows-949",
    "gb18030" to "GB18030",
    "gbk" to "GB18030",
    "iso-2022-jp" to "ISO-2022-JP",
    "shift_jis" to "windows-31j",
)

private fun asciiLower(text: String): String = buildString { for (c in text) append(if (c in 'A'..'Z') c + 32 else c) }

private fun isHttpToken(text: String): Boolean = text.isNotEmpty() && text.all { it in HTTP_TOKEN }

/** Whether a parameter's value may hold `c`: a tab, U+0020 to U+007E, and U+0080 to U+00FF. */
private fun isOfAParameterValue(c: Char): Boolean = c == '\t' || c in ' '..'~' || c in '\u0080'..'ÿ'

/** The quoted string that opens at `start`, without its quotation marks, and where it ends. */
private fun quotedString(text: String, start: Int): Pair<String, Int> {
    var position = start + 1
    val value = StringBuilder()
    while (true) {
        val opened = position
        while (position < text.length && text[position] != '"' && text[position] != '\\') position += 1
        value.append(text, opened, position)
        if (position >= text.length) break
        val mark = text[position]
        position += 1
        if (mark == '"') break
        // A backslash gives the character after it, and at the very end is itself.
        if (position >= text.length) {
            value.append('\\')
            break
        }
        value.append(text[position])
        position += 1
    }
    return value.toString() to position
}

/**
 * The value of a content type's `charset` parameter, as the MIME Sniffing
 * Standard parses a MIME type: the first parameter of that name that is one.
 * None where there is none, and where the content type is no MIME type.
 */
private fun charsetOf(contentType: String): String? {
    val text = contentType.trim { it in HTTP_WHITE_SPACE }
    val slash = text.indexOf('/')
    if (slash < 0 || !isHttpToken(text.substring(0, slash))) return null
    val subtype = text.substring(slash + 1).substringBefore(';')
    if (!isHttpToken(subtype.trimEnd { it in HTTP_WHITE_SPACE })) return null
    var position = slash + 1 + subtype.length
    while (position < text.length) {
        position += 1 // past the semicolon
        while (position < text.length && text[position] in HTTP_WHITE_SPACE) position += 1
        var opened = position
        while (position < text.length && text[position] != ';' && text[position] != '=') position += 1
        val name = asciiLower(text.substring(opened, position))
        if (position < text.length) {
            if (text[position] == ';') continue
            position += 1 // past the equals sign
        }
        if (position >= text.length) break
        val value: String
        if (text[position] == '"') {
            val (quoted, end) = quotedString(text, position)
            value = quoted
            position = end
            while (position < text.length && text[position] != ';') position += 1
        } else {
            opened = position
            while (position < text.length && text[position] != ';') position += 1
            value = text.substring(opened, position).trimEnd { it in HTTP_WHITE_SPACE }
            if (value.isEmpty()) continue
        }
        if (name == "charset" && value.all(::isOfAParameterValue)) return value
    }
    return null
}

/**
 * The encoding a content type states: none where it states none, or an empty
 * one. It is stated by a label of the Encoding Standard, read in lower case and
 * without the white space around it. One the standard lacks is refused, and so
 * is one of an encoding it reads no text under.
 */
private fun statedEncoding(contentType: String): String? {
    val stated = charsetOf(contentType)?.takeIf { it.isNotEmpty() } ?: return null
    val encoding = ENCODING_OF_LABEL[asciiLower(stated.trim { it in ASCII_WHITE_SPACE })]
    if (encoding == null || encoding in REFUSED) throw undecoded(stated)
    return encoding
}

private fun undecoded(stated: String) =
    TransportError(TransportErrorCode.Error, "The resource's text is $stated, which is no charset the Encoding Standard decodes: read its bytes instead")

/** The Encoding Standard's UTF-8 decoder: a U+FFFD for each maximal part of a sequence that is not one. */
private fun utf8(data: ByteArray, from: Int): String = buildString {
    var needed = 0
    var seen = 0
    var codePoint = 0
    var lower = 0x80
    var upper = 0xbf
    var at = from
    while (at < data.size) {
        val byte = data[at].toInt() and 0xff
        if (needed == 0) {
            when (byte) {
                in 0x00..0x7f -> append(byte.toChar())
                in 0xc2..0xdf -> { needed = 1; codePoint = byte and 0x1f }
                in 0xe0..0xef -> {
                    if (byte == 0xe0) lower = 0xa0
                    if (byte == 0xed) upper = 0x9f
                    needed = 2
                    codePoint = byte and 0xf
                }
                in 0xf0..0xf4 -> {
                    if (byte == 0xf0) lower = 0x90
                    if (byte == 0xf4) upper = 0x8f
                    needed = 3
                    codePoint = byte and 0x7
                }
                else -> append(REPLACEMENT)
            }
            at += 1
            continue
        }
        if (byte !in lower..upper) {
            // The byte begins what comes next: it is read again.
            needed = 0
            seen = 0
            codePoint = 0
            lower = 0x80
            upper = 0xbf
            append(REPLACEMENT)
            continue
        }
        lower = 0x80
        upper = 0xbf
        codePoint = (codePoint shl 6) or (byte and 0x3f)
        seen += 1
        at += 1
        if (seen == needed) {
            appendCodePoint(codePoint)
            needed = 0
            seen = 0
            codePoint = 0
        }
    }
    if (needed != 0) append(REPLACEMENT)
}

/** The Encoding Standard's UTF-16 decoder: a U+FFFD for a surrogate that has no partner, and one for an odd byte at the end. */
private fun utf16(data: ByteArray, from: Int, bigEndian: Boolean): String = buildString {
    var lead: Char? = null
    var at = from
    while (at + 1 < data.size) {
        val high = data[at].toInt() and 0xff
        val low = data[at + 1].toInt() and 0xff
        val unit = (if (bigEndian) (high shl 8) or low else (low shl 8) or high).toChar()
        at += 2
        val pending = lead
        if (pending != null) {
            lead = null
            if (unit.isLowSurrogate()) {
                append(pending)
                append(unit)
                continue
            }
            // The unit is read again, as what comes after a surrogate with no partner.
            append(REPLACEMENT)
        }
        when {
            unit.isHighSurrogate() -> lead = unit
            unit.isLowSurrogate() -> append(REPLACEMENT)
            else -> append(unit)
        }
    }
    if (lead != null || at < data.size) append(REPLACEMENT)
}

/** Bytes in one of the standard's legacy multi-byte encodings, by the JDK's decoder of it. One this runtime lacks is refused, by its name. */
private fun legacy(data: ByteArray, encoding: String): String {
    val charset = try {
        Charset.forName(LEGACY_MULTI_BYTE.getValue(encoding))
    } catch (_: UnsupportedCharsetException) {
        throw TransportError(TransportErrorCode.Error, "The resource's text is $encoding, which this runtime does not decode: read its bytes instead")
    }
    return charset.newDecoder()
        .onMalformedInput(CodingErrorAction.REPLACE)
        .onUnmappableCharacter(CodingErrorAction.REPLACE)
        .replaceWith(REPLACEMENT.toString())
        .decode(ByteBuffer.wrap(data))
        .toString()
}

private val UTF8_MARK = byteArrayOf(0xef.toByte(), 0xbb.toByte(), 0xbf.toByte())
private val UTF16BE_MARK = byteArrayOf(0xfe.toByte(), 0xff.toByte())
private val UTF16LE_MARK = byteArrayOf(0xff.toByte(), 0xfe.toByte())

private fun ByteArray.startsWith(mark: ByteArray): Boolean = size >= mark.size && mark.indices.all { this[it] == mark[it] }

/**
 * Bytes as the text they are, by the rule every reader of a resource's text
 * keeps (docs/protocol/W3C-SELECTORS.md, The text of a resource).
 * `mediaType` is the content type the bytes came with.
 *
 * Only a type whose bytes are its text is read: one whose text is derived
 * from its bytes, and one with no text, is refused, by its media type, before
 * its charset is read. The charset is the one the content type states, UTF-8
 * when it states none, and is a label of the Encoding Standard: any other is
 * refused, by its name. Bytes that begin with the byte-order mark of UTF-8,
 * UTF-16BE or UTF-16LE are in that encoding, whatever was stated, and the mark
 * is not part of the text. What the encoding does not have is U+FFFD. Each
 * refusal is a `TransportError` whose code is `error`.
 */
internal fun decodeRepresentation(data: ByteArray, mediaType: String): String {
    val base = baseMediaType(mediaType)
    if (derivesTextOf(mediaType)) {
        throw TransportError(TransportErrorCode.Error, "The resource is $base, whose text is derived from its bytes, not decoded: read its anchored text instead")
    }
    if (textSourceOf(mediaType) == TextSource.None) {
        throw TransportError(TransportErrorCode.Error, "The resource is $base, which has no text: read its bytes instead")
    }
    val encoding = statedEncoding(mediaType)
    return when {
        data.startsWith(UTF8_MARK) -> utf8(data, UTF8_MARK.size)
        data.startsWith(UTF16BE_MARK) -> utf16(data, UTF16BE_MARK.size, bigEndian = true)
        data.startsWith(UTF16LE_MARK) -> utf16(data, UTF16LE_MARK.size, bigEndian = false)
        encoding == null || encoding == "utf-8" -> utf8(data, 0)
        encoding == "utf-16be" -> utf16(data, 0, bigEndian = true)
        encoding == "utf-16le" -> utf16(data, 0, bigEndian = false)
        else -> SINGLE_BYTE[encoding]?.let { table -> buildString { for (byte in data) append(table[byte.toInt() and 0xff]) } } ?: legacy(data, encoding)
    }
}
