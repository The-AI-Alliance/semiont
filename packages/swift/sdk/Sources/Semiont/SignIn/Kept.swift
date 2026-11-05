import Foundation
import Synchronization

public protocol SignInKept: Sendable {
  func held() async throws -> HeldSignIn?
  func keep(_ signIn: HeldSignIn) async throws
  func renewed(read: HeldSignIn, access: String, refresh: String) async throws -> String?
  func forget() async throws
}
public final class MemorySignIn: SignInKept {
  private let value: Mutex<HeldSignIn?>
  public init(_ signIn: HeldSignIn? = nil) { value = Mutex(signIn) }
  public func held() async -> HeldSignIn? { value.withLock { $0 } }
  public func keep(_ signIn: HeldSignIn) async { value.withLock { $0 = signIn } }
  public func renewed(read: HeldSignIn, access: String, refresh: String) async -> String? {
    value.withLock { held in
      guard let current = held else { return nil }
      guard current.access == read.access && current.refresh == read.refresh else {
        return current.access
      }
      held = HeldSignIn(
        access: access, clientId: current.clientId, refresh: refresh,
        revocationEndpoint: current.revocationEndpoint, tokenEndpoint: current.tokenEndpoint)
      return access
    }
  }
  public func forget() async { value.withLock { $0 = nil } }
}
public enum Platform: Sendable { case macos, windows, other }
public func stateDir(
  platform: Platform, home: String?, xdgStateHome: String? = nil, localAppData: String? = nil
) -> String? {
  guard let home, !home.isEmpty else { return nil }
  func under(_ root: String, _ separator: String, _ parts: String...) -> String {
    var root = root
    while root.hasSuffix(separator) { root.removeLast() }
    return ([root] + parts).joined(separator: separator)
  }
  switch platform {
  case .macos: return under(home, "/", "Library", "Application Support", "semiont")
  case .windows:
    if let localAppData, !localAppData.isEmpty { return under(localAppData, "\\", "semiont") }
    return under(home, "\\", "AppData", "Local", "semiont")
  case .other:
    if let xdgStateHome, !xdgStateHome.isEmpty { return under(xdgStateHome, "/", "semiont") }
    return under(home, "/", ".local", "state", "semiont")
  }
}
var scriptClientID: String {
  guard let row = oauthClients.first(where: { $0.name == "script" }) else {
    preconditionFailure("No script OAuth client")
  }
  return row.id
}
