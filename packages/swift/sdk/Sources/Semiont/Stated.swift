/// A member that is both optional and nullable: absence, explicit null, or a value.
public enum Stated<Value: Sendable>: Sendable {
  case absent
  case null
  case value(Value)
}
extension Stated: Equatable where Value: Equatable {}

struct WireKey: CodingKey {
  let stringValue: String
  var intValue: Int? { nil }
  init(_ value: String) { stringValue = value }
  init?(stringValue: String) { self.stringValue = stringValue }
  init?(intValue: Int) { return nil }
}
