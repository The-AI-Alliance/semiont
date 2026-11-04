public struct OpenResource: Codable, Sendable {
  public let id: ResourceId
  public var name: String
  public let openedAt: Int64
  public var order: Int
  public var mediaType: String?
  public var storageUri: String?

  public init(
    id: ResourceId, name: String, openedAt: Int64, order: Int,
    mediaType: String? = nil, storageUri: String? = nil
  ) {
    self.id = id
    self.name = name
    self.openedAt = openedAt
    self.order = order
    self.mediaType = mediaType
    self.storageUri = storageUri
  }
}

public enum TabVerdict: String, Codable, Sendable {
  case gone, ready, unknown
}

public struct TabCheck: Codable, Sendable {
  public let verdict: TabVerdict
  public let name: String?
  public let mediaType: String?

  public init(_ verdict: TabVerdict, name: String? = nil, mediaType: String? = nil) {
    self.verdict = verdict
    self.name = name
    self.mediaType = mediaType
  }
}

public func sortOpenResources(_ resources: [OpenResource]) -> [OpenResource] {
  resources.sorted { ($0.order, $0.openedAt) < ($1.order, $1.openedAt) }
}

public func applyTabChecks(
  _ resources: [OpenResource], checks: [ResourceId: TabCheck]
) -> [OpenResource] {
  resources.compactMap { resource in
    guard let check = checks[resource.id] else { return resource }
    switch check.verdict {
    case .gone: return nil
    case .unknown: return resource
    case .ready:
      var refreshed = resource
      if let name = check.name { refreshed.name = name }
      if let mediaType = check.mediaType, !mediaType.isEmpty { refreshed.mediaType = mediaType }
      return refreshed
    }
  }
}

func checkOpenResource(_ client: SemiontClient, id: ResourceId) async -> TabCheck {
  do {
    let descriptor = try await client.browse.resource(id).fresh()
    let mediaType: String? =
      switch descriptor.representations {
      case .representation(let representation): representation.mediaType
      case .list(let representations): representations.first?.mediaType
      }
    return TabCheck(.ready, name: descriptor.name, mediaType: mediaType)
  } catch let error as BusRequestError where error.reason == .busNotFound {
    return TabCheck(.gone)
  } catch {
    return TabCheck(.unknown)
  }
}
