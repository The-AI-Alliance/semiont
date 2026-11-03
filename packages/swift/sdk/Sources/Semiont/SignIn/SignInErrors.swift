public struct SignInError: Error, Sendable, CustomStringConvertible {
  public let reason: SignInErrorCode
  public let description: String
  public let status: Int?
  public var code: String { reason.rawValue }
  init(_ reason: SignInErrorCode, _ description: String, status: Int? = nil) {
    self.reason = reason
    self.description = description
    self.status = status
  }
}
public struct SessionError: Error, Sendable, CustomStringConvertible {
  public let reason: SessionErrorCode
  public let description: String
  public let kbId: String
  public var code: String { reason.rawValue }
  init(_ reason: SessionErrorCode, _ description: String, kbId: String) {
    self.reason = reason
    self.description = description
    self.kbId = kbId
  }
}
