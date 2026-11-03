func itemsOf(_ body: AnnotationBodies?) -> [AnnotationBody] {
  switch body {
  case .annotationBody(let item): return [item]
  case .list(let items): return items
  case nil: return []
  }
}
func selectorsOf(_ selector: AnnotationSelector) -> [Selector] {
  switch selector {
  case .selector(let item): return [item]
  case .list(let items): return items
  }
}
public func bodySource(_ body: AnnotationBodies?) -> ResourceId? {
  itemsOf(body).compactMap { item in
    if case .specificResource(let resource) = item { return resource.source }
    return nil
  }.first
}
public func targetSource(_ target: AnnotationTargetValue) -> ResourceId {
  switch target {
  case .resourceId(let id): return id
  case .annotationTarget(let target): return target.source
  }
}
public func targetSelector(_ target: AnnotationTargetValue) -> AnnotationSelector? {
  if case .annotationTarget(let target) = target { return target.selector }
  return nil
}
public func isBodyResolved(_ body: AnnotationBodies?) -> Bool { bodySource(body) != nil }
public func isHighlight(_ annotation: Annotation) -> Bool { annotation.motivation == .highlighting }
public func isReference(_ annotation: Annotation) -> Bool { annotation.motivation == .linking }
public func isAssessment(_ annotation: Annotation) -> Bool { annotation.motivation == .assessing }
public func isComment(_ annotation: Annotation) -> Bool { annotation.motivation == .commenting }
public func isTag(_ annotation: Annotation) -> Bool { annotation.motivation == .tagging }
public func isStubReference(_ annotation: Annotation) -> Bool {
  isReference(annotation) && !isBodyResolved(annotation.body)
}
public func isResolvedReference(_ annotation: Annotation) -> Bool {
  isReference(annotation) && isBodyResolved(annotation.body)
}
public func commentText(_ annotation: Annotation) -> String? {
  guard isComment(annotation), case .textualBody(let body) = itemsOf(annotation.body).first else {
    return nil
  }
  return body.value
}
public func textQuoteSelector(_ selector: AnnotationSelector) -> TextQuoteSelector? {
  for item in selectorsOf(selector) {
    if case .textQuoteSelector(let value) = item { return value }
  }
  return nil
}
public func textPositionSelector(_ selector: AnnotationSelector) -> TextPositionSelector? {
  for item in selectorsOf(selector) {
    if case .textPositionSelector(let value) = item { return value }
  }
  return nil
}
public func svgSelector(_ selector: AnnotationSelector) -> SvgSelector? {
  for item in selectorsOf(selector) { if case .svgSelector(let value) = item { return value } }
  return nil
}
public func fragmentSelector(_ selector: AnnotationSelector) -> FragmentSelector? {
  for item in selectorsOf(selector) { if case .fragmentSelector(let value) = item { return value } }
  return nil
}
public func exactText(_ selector: AnnotationSelector?) -> String {
  selector.flatMap(textQuoteSelector)?.exact ?? ""
}
public func annotationExactText(_ annotation: Annotation) -> String {
  exactText(targetSelector(annotation.target))
}
private func textsFor(_ annotation: Annotation, _ purpose: BodyPurpose) -> [String] {
  itemsOf(annotation.body).compactMap { item in
    if case .textualBody(let body) = item, body.purpose == purpose { return body.value }
    return nil
  }
}
public func entityTypes(_ annotation: Annotation) -> [String] {
  textsFor(annotation, .tagging).filter { !$0.isEmpty }
}
public func tagCategory(_ annotation: Annotation) -> String? {
  isTag(annotation) ? textsFor(annotation, .tagging).first : nil
}
public func tagSchemaId(_ annotation: Annotation) -> String? {
  isTag(annotation) ? textsFor(annotation, .classifying).first : nil
}
