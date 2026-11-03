import Foundation
import Testing

@testable import Semiont

@Test func reconcileRunsEverySharedCase() throws {
  for value in try required(Spec.read("annotations/reconcile-cases.json").object, "cases").array {
    let row = try value.object
    let actual = reconcile(
      text: try required(row, "text").text,
      quoted: try decoded(QuotedText.self, required(row, "quoted")))
    let answer = try actual.map(encoded) ?? .null
    let expected = try required(row, "reconciled")
    let why = try required(row, "why").text
    #expect(answer == expected, "\(why)")
  }
}
@Test func annotationReadersRunEverySharedCase() throws {
  let table = try Spec.read("annotations/reader-cases.json").object
  for value in try required(table, "cases").array {
    let row = try value.object
    let annotation = try decoded(Annotation.self, required(row, "annotation"))
    let selector = targetSelector(annotation.target)
    let answers: [String: JSONValue] = [
      "bodySource": bodySource(annotation.body).map { .string($0.value) } ?? .null,
      "isBodyResolved": .bool(isBodyResolved(annotation.body)),
      "targetSource": .string(targetSource(annotation.target).value),
      "targetSelector": try selector.map(encoded) ?? .null,
      "isHighlight": .bool(isHighlight(annotation)), "isReference": .bool(isReference(annotation)),
      "isAssessment": .bool(isAssessment(annotation)), "isComment": .bool(isComment(annotation)),
      "isTag": .bool(isTag(annotation)),
      "commentText": commentText(annotation).map(JSONValue.string) ?? .null,
      "isStubReference": .bool(isStubReference(annotation)),
      "isResolvedReference": .bool(isResolvedReference(annotation)),
      "exactText": .string(exactText(selector)),
      "annotationExactText": .string(annotationExactText(annotation)),
      "textQuoteSelector": try selector.flatMap(textQuoteSelector).map(encoded) ?? .null,
      "entityTypes": .array(entityTypes(annotation).map(JSONValue.string)),
      "tagCategory": tagCategory(annotation).map(JSONValue.string) ?? .null,
      "tagSchemaId": tagSchemaId(annotation).map(JSONValue.string) ?? .null,
    ]
    #expect(Set(answers.keys) == Set(try required(table, "readers").array.map { try $0.text }))
    for (name, expected) in try required(row, "reads").object {
      #expect(answers[name] == expected, "\(name)")
    }
  }
}
@Test func annotationIDsRunEverySharedCase() throws {
  for value in try required(Spec.read("annotations/id-cases.json").object, "cases").array {
    let row = try value.object
    let id = try annotationID(
      resourceId: decoded(ResourceId.self, required(row, "resourceId")),
      motivation: decoded(Motivation.self, required(row, "motivation")),
      anchor: required(row, "anchor").text, body: row["body"])
    #expect(id.value == (try required(row, "id").text))
  }
}
@Test func annotationBuildersRunEverySharedCase() throws {
  let table = try Spec.read("annotations/builder-cases.json").object
  for key in ["cases", "resources"] {
    for value in try required(table, key).array {
      let row = try value.object
      do {
        let annotation: Annotation
        if key == "resources" {
          annotation = try annotationOfResource(
            OfResource(
              resourceId: decoded(ResourceId.self, required(row, "resourceId")),
              motivation: decoded(Motivation.self, required(row, "motivation")),
              generator: row["generator"].map { try decoded(Agent.self, $0) },
              body: row["body"].map { try decoded(AnnotationBodies.self, $0) }))
        } else {
          annotation = try annotationOfSpan(
            OfSpan(
              resourceId: decoded(ResourceId.self, required(row, "resourceId")),
              motivation: decoded(Motivation.self, required(row, "motivation")),
              generator: decoded(Agent.self, required(row, "generator")),
              span: decoded(TextSpan.self, required(row, "span")),
              body: row["body"].map { try decoded(AnnotationBodies.self, $0) },
              text: row["text"].map { .text(try $0.text) }
                ?? .anchored(decoded(AnchoredText.self, required(row, "anchored")))))
        }
        var actual = try encoded(annotation).object
        #expect(actual.removeValue(forKey: "created") != nil)
        #expect(JSONValue.object(actual) == (try required(row, "annotation")))
      } catch let error as SpanRefusedError {
        #expect(JSONValue.string(error.code) == row["refused"])
      } catch {
        throw SpecFailure.shape("\(try required(row, "why").text): \(error)")
      }
    }
  }
}
@Test func pdfLocationRunsEverySDKCase() throws {
  for value in try required(Spec.read("annotations/pdf-locate-cases.json").object, "cases").array {
    let row = try value.object
    let span = try required(row, "span").object
    let result = try locate(
      decoded(AnchoredText.self, required(row, "anchored")),
      start: Int(number(required(span, "start"))), end: Int(number(required(span, "end"))))
    #expect(try encoded(result.0) == required(row, "overlapping"))
    #expect(try encoded(result.1) == required(row, "rects"))
    #expect(try encoded(result.1.map(fragmentOf)) == required(row, "fragments"))
  }
}
@Test func textOffsetsRunEverySharedCase() throws {
  for value in try required(Spec.read("text/offset-cases.json").object, "cases").array {
    let row = try value.object
    let text = ScalarText(try required(row, "text").text)
    #expect(text.count == (try Int(number(required(row, "codePoints")))))
    for value in try required(row, "spans").array {
      let span = try value.object
      let words = try required(span, "exact").text
      let occurrence = try Int(number(required(span, "occurrence")))
      let start = try Int(number(required(span, "start")))
      let end = try Int(number(required(span, "end")))
      let places = text.places(ScalarText(words))
      try #require(places.indices.contains(occurrence - 1))
      #expect(places[occurrence - 1] == start)
      #expect(text.text(start, end).unicodeScalars.elementsEqual(words.unicodeScalars))
    }
  }
}
@Test func reconciliationVocabulariesAreInCensus() throws {
  let rows = try required(Spec.read("annotations/reconcile-cases.json").object, "cases").array
  let answered = try rows.compactMap { row -> [String: JSONValue]? in
    let value = try required(row.object, "reconciled")
    return value == .null ? nil : try value.object
  }
  #expect(
    Set(AnchorMethod.allCases.map(\.rawValue))
      == Set(try answered.map { try required($0, "anchorMethod").text }))
  #expect(
    Set(MatchQuality.allCases.map(\.rawValue))
      == Set(try answered.compactMap { try $0["matchQuality"]?.text }))
}

@Test func selectorReadersFindTheirOwnKindAndRefuseTheOthers() throws {
  let position = Selector.textPositionSelector(TextPositionSelector(end: 3, start: 1))
  let svg = Selector.svgSelector(SvgSelector(value: "<svg/>"))
  let fragment = Selector.fragmentSelector(FragmentSelector(value: "page=2"))
  let quote = Selector.textQuoteSelector(TextQuoteSelector(exact: "words"))
  let selectors = AnnotationSelector.list([position, svg, fragment, quote])
  #expect(textPositionSelector(selectors)?.start == 1)
  #expect(svgSelector(selectors)?.value == "<svg/>")
  #expect(fragmentSelector(selectors)?.value == "page=2")
  #expect(textQuoteSelector(selectors)?.exact == "words")
  #expect(textPositionSelector(.selector(quote)) == nil)
  #expect(svgSelector(.selector(quote)) == nil)
  #expect(fragmentSelector(.selector(quote)) == nil)
  #expect(textQuoteSelector(.selector(position)) == nil)
}
