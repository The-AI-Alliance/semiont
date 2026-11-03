import Foundation

func base64URL(_ data: Data) -> String {
  data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
func base64URLData(_ text: String) -> Data? {
  guard
    text.utf8.allSatisfy({
      (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45
        || $0 == 95
    })
  else { return nil }
  var encoded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(
    of: "_", with: "/")
  encoded += String(repeating: "=", count: (4 - encoded.utf8.count % 4) % 4)
  return Data(base64Encoded: encoded)
}
private func claims(_ token: String) -> [String: JSONValue]? {
  let parts = token.split(separator: ".", omittingEmptySubsequences: false)
  guard parts.count == 3, let data = base64URLData(String(parts[1])) else { return nil }
  return try? JSONDecoder().decode([String: JSONValue].self, from: data)
}
public func textClaim(_ token: String, name: String) -> String? {
  guard case .string(let value) = claims(token)?[name] else { return nil }
  return value
}
private func seconds(_ values: [String: JSONValue], _ name: String) -> Double? {
  guard case .number(let value) = values[name], value != 0 else { return nil }
  return value
}
public func tokenExpiry(_ token: String) -> Double? {
  claims(token).flatMap { seconds($0, "exp") }
}
public func isTokenExpired(_ token: String, now: Double) -> Bool {
  tokenExpiry(token).map { $0 < now } ?? true
}
public func renewalDelay(lifetime: Double, remaining: Double) -> Double {
  max(
    remaining - min(Double(Timings.refreshBeforeExpMs) / 1000, lifetime / 2),
    Double(Timings.minRefreshDelayMs) / 1000)
}
public func refreshDelay(_ token: String, now: Double) -> Double? {
  guard let values = claims(token), let expiry = seconds(values, "exp") else { return nil }
  let remaining = max(expiry - now, 0)
  let lifetime = seconds(values, "iat").map { max(expiry - $0, 0) } ?? remaining
  return renewalDelay(lifetime: lifetime, remaining: remaining)
}
