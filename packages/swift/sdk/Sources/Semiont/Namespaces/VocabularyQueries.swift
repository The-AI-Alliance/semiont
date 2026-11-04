struct VocabularyQueries: Sendable {
  let entityTypes: Cached<[String]>
  let tagSchemas: Cached<[TagSchema]>

  init(wire: Bus, lifetime: Lifetime) {
    entityTypes = Cached(lifetime: lifetime) {
      try await wire.request(Operations.browseEntityTypesRequested, BrowseEntityTypesRequest())
        .response.entityTypes
    }
    tagSchemas = Cached(lifetime: lifetime) {
      try await wire.request(Operations.browseTagSchemasRequested, BrowseTagSchemasRequest())
        .response.tagSchemas
    }
  }

  func refresh(on trigger: String, coalescing: Bool) async {
    for rule in cacheRefresh where rule.on == trigger {
      for query in rule.refetches ?? [] {
        switch query {
        case "entityTypes": await entityTypes.refreshIfKnown(coalescing: coalescing)
        case "tagSchemas": await tagSchemas.refreshIfKnown(coalescing: coalescing)
        default: break
        }
      }
    }
  }
}
