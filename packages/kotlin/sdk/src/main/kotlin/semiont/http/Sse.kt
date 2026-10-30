package semiont.http

import java.io.ByteArrayOutputStream

/** One event of an event stream: its type, its id when it has one, and its data. */
internal class SseEvent(val event: String, val id: String?, val data: String)

/**
 * A `text/event-stream` parser that holds its state across reads. A frame can
 * span many reads, and a read can end anywhere: inside a line, between a line
 * and its blank line, inside a character. Lines are cut at their `\n` byte,
 * so a character is only ever decoded whole.
 */
internal class SseParser {
    private val line = ByteArrayOutputStream()
    private var event = "message"
    private var id: String? = null
    private val data = StringBuilder()
    private var hasData = false

    fun feed(read: ByteArray): List<SseEvent> {
        val events = mutableListOf<SseEvent>()
        for (byte in read) {
            if (byte == '\n'.code.toByte()) {
                var text = line.toString(Charsets.UTF_8)
                line.reset()
                if (text.endsWith('\r')) text = text.dropLast(1)
                take(text)?.let(events::add)
            } else {
                line.write(byte.toInt())
            }
        }
        return events
    }

    private fun take(text: String): SseEvent? {
        if (text.isEmpty()) {
            val dispatched = if (hasData) SseEvent(event, id, data.toString()) else null
            event = "message"
            id = null
            data.clear()
            hasData = false
            return dispatched
        }
        if (text.startsWith(':')) return null
        val field = text.substringBefore(':')
        val value = if (':' in text) text.substringAfter(':').removePrefix(" ") else ""
        when (field) {
            "event" -> event = value
            "id" -> id = value
            "data" -> {
                if (hasData) data.append('\n')
                data.append(value)
                hasData = true
            }
        }
        return null
    }
}
