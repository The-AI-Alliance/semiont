public protocol StateUnit: Sendable {
  func dispose()
}

public struct SessionEnded: Codable, Sendable {
  public let reason: SessionEndReason
}

public struct PermissionDenied: Encodable, Sendable {
  public let detail: String?

  private enum CodingKeys: String, CodingKey { case detail }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(detail, forKey: .detail)
  }
}

public struct KbIdentityConflict: Codable, Sendable {
  public let expectedDid: String
  public let observedDid: String

  public init(expectedDid: String, observedDid: String) {
    self.expectedDid = expectedDid
    self.observedDid = observedDid
  }
}

public final class SessionSignals: StateUnit {
  public let sessionEnded = Watched<SessionEnded?>(nil)
  public let permissionDenied = Watched<PermissionDenied?>(nil)
  public let kbIdentityConflict = Watched<KbIdentityConflict?>(nil)

  public init() {}

  public func notifySessionEnded(_ reason: SessionEndReason) {
    sessionEnded.set(SessionEnded(reason: reason))
  }

  public func notifyPermissionDenied(_ detail: String?) {
    permissionDenied.set(PermissionDenied(detail: detail))
  }

  public func notifyKbIdentityConflict(_ conflict: KbIdentityConflict) {
    kbIdentityConflict.set(conflict)
  }

  public func acknowledgeSessionEnded() { sessionEnded.set(nil) }
  public func acknowledgePermissionDenied() { permissionDenied.set(nil) }
  public func acknowledgeKbIdentityConflict() { kbIdentityConflict.set(nil) }

  public func dispose() {
    sessionEnded.finish()
    permissionDenied.finish()
    kbIdentityConflict.finish()
  }

  deinit { dispose() }
}
