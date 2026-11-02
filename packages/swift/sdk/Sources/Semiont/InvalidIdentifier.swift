/// A string refused by the spec's rule for an identifier kind.
public struct InvalidIdentifier: Error, Sendable, Equatable {
  public let kind: String
  public let pattern: String
  public let value: String
}
