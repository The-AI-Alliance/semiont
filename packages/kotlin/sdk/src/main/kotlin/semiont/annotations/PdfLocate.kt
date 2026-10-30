package semiont.annotations

import semiont.types.AnchoredText
import semiont.types.PdfTextItem
import java.math.BigDecimal
import kotlin.math.abs

/*
 * Where a span of a PDF's text is on its pages
 * (specs/src/annotations/pdf-locate-cases.json): one rectangle for each line
 * it touches, each written as an RFC 3778 fragment. Coordinates are PDF points
 * from the bottom-left corner of the page, `y` growing upward.
 */

/** Items whose `y` is within this many points of the first item of a line are on that line. */
private const val SAME_LINE = 2.0

/** A rectangle on a page: its bottom-left corner and its size, in PDF points. */
internal data class Rectangle(val page: Double, val x: Double, val y: Double, val width: Double, val height: Double)

/** A page's items as its lines, the top of the page first and each line from its left. */
private fun linesOf(items: List<PdfTextItem>): List<List<PdfTextItem>> {
    val lines = mutableListOf<MutableList<PdfTextItem>>()
    for (item in items.sortedWith(compareBy({ -it.y }, { it.x }))) {
        val line = lines.lastOrNull()
        if (line != null && abs(item.y - line.first().y) <= SAME_LINE) line += item else lines += mutableListOf(item)
    }
    return lines
}

/** An item's left and right edges, each moved in where the span cuts the item: in proportion to the code points cut off. */
private fun edgesOf(item: PdfTextItem, start: Long, end: Long): Pair<Double, Double> {
    val count = (item.end - item.start).toDouble()
    val left = if (item.start < start) item.x + item.width * ((start - item.start) / count) else item.x
    val right = if (item.end > end) item.x + item.width * ((end - item.start) / count) else item.x + item.width
    return left to right
}

/** The rectangle that spans a line's items, as far as the span reaches into each. */
private fun spanning(page: Double, line: List<PdfTextItem>, start: Long, end: Long): Rectangle {
    val edges = line.map { edgesOf(it, start, end) }
    val x = edges.minOf { it.first }
    val y = line.minOf { it.y }
    return Rectangle(page, x, y, edges.maxOf { it.second } - x, line.maxOf { it.y + it.height } - y)
}

/**
 * The items a span of the anchored text overlaps, in the text's order, and a
 * rectangle for each line of each page it touches. Pages come in the order
 * their first overlapped item has in the text. A span that no item overlaps
 * has neither, and an empty span overlaps none.
 */
internal fun locate(anchored: AnchoredText, start: Long, end: Long): Pair<List<PdfTextItem>, List<Rectangle>> {
    // An empty span has no character for an item to hold, inside one as between two.
    if (start == end) return emptyList<PdfTextItem>() to emptyList()
    val overlapping = anchored.items.filter { it.start < end && it.end > start }
    val pages = overlapping.groupBy { it.page }
    return overlapping to pages.flatMap { (page, items) -> linesOf(items).map { spanning(page, it, start, end) } }
}

/** A number as the shortest decimal that reads back as it, with no exponent: a whole number has no point. */
private fun decimal(number: Double): String = BigDecimal(number.toString()).stripTrailingZeros().toPlainString()

/** A rectangle as the value of a `FragmentSelector`: `page=P&viewrect=X,Y,W,H`. */
internal fun fragmentOf(rectangle: Rectangle): String =
    "page=${decimal(rectangle.page)}&viewrect=${decimal(rectangle.x)},${decimal(rectangle.y)},${decimal(rectangle.width)},${decimal(rectangle.height)}"
