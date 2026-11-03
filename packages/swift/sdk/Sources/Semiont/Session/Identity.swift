import Foundation

public func encodeUriComponent(_ value: String) -> String {
  value.utf8.map { byte in
    if (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte)
      || "-_.!~*'()".utf8.contains(byte)
    {
      return String(UnicodeScalar(byte))
    }
    return String(format: "%%%02X", byte)
  }.joined()
}
public func kbDid(_ domain: String) throws -> UserId { try UserId("did:web:" + domain) }
public func kbResource(_ domain: String) -> String {
  "https://" + domain.replacingOccurrences(of: ":", with: "/")
}
public func personDid(_ domain: String, _ subject: String) throws -> UserId {
  try UserId("did:web:" + domain + ":users:" + encodeUriComponent(subject))
}
public func agentDid(_ domain: String, _ subject: String) throws -> UserId {
  try UserId("did:web:" + domain + ":agents:" + encodeUriComponent(subject))
}
public func isValidHostname(_ host: String) -> Bool {
  host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { label in
    let bytes = Array(label.utf8)
    func alphanumeric(_ byte: UInt8) -> Bool {
      (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte)
    }
    guard (1...63).contains(bytes.count), let first = bytes.first, let last = bytes.last,
      alphanumeric(first), alphanumeric(last)
    else { return false }
    return bytes.allSatisfy { alphanumeric($0) || $0 == 45 }
  }
}
public func gatewayUrl(_ endpoint: HttpEndpoint) throws -> String {
  guard isValidHostname(endpoint.host) else { throw SignInError(.discovery, "Invalid KB hostname") }
  return "\(endpoint.protocol.rawValue)://\(endpoint.host.lowercased()):\(endpoint.port)"
}
