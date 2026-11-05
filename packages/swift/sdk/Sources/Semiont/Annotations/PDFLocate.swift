import Foundation

struct Rectangle: Codable {
  let page: Double
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}
func locate(_ anchored: AnchoredText, start: Int, end: Int) -> ([PdfTextItem], [Rectangle]) {
  guard start != end else { return ([], []) }
  let overlapping = anchored.items.filter { $0.start < end && $0.end > start }
  var pages: [Double] = []
  for item in overlapping where !pages.contains(item.page) { pages.append(item.page) }
  var rectangles: [Rectangle] = []
  for page in pages {
    let items = overlapping.filter { $0.page == page }.sorted {
      $0.y == $1.y ? $0.x < $1.x : $0.y > $1.y
    }
    var lines: [[PdfTextItem]] = []
    for item in items {
      if let first = lines.last?.first, abs(item.y - first.y) <= 2 {
        lines[lines.count - 1].append(item)
      } else {
        lines.append([item])
      }
    }
    for line in lines {
      let edges = line.map { item in
        let count = Double(item.end - item.start)
        let left =
          item.start < start ? item.x + item.width * (Double(start - item.start) / count) : item.x
        let right =
          item.end > end
          ? item.x + item.width * (Double(end - item.start) / count) : item.x + item.width
        return (left, right)
      }
      if let x = edges.map(\.0).min(), let right = edges.map(\.1).max(),
        let y = line.map(\.y).min(), let top = line.map({ $0.y + $0.height }).max()
      {
        rectangles.append(Rectangle(page: page, x: x, y: y, width: right - x, height: top - y))
      }
    }
  }
  return (overlapping, rectangles)
}
func fragmentOf(_ rectangle: Rectangle) -> String {
  func decimal(_ number: Double) -> String {
    let text = String(number)
    if text.hasSuffix(".0") { return String(text.dropLast(2)) }
    return text
  }
  return
    "page=\(decimal(rectangle.page))&viewrect=\(decimal(rectangle.x)),\(decimal(rectangle.y)),\(decimal(rectangle.width)),\(decimal(rectangle.height))"
}
