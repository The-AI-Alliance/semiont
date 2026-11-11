import Foundation
import Synchronization

public protocol SignInKept: Sendable {
  func held() async throws -> HeldSignIn?
  func keep(_ signIn: HeldSignIn) async throws
  func renewed(read: HeldSignIn, access: String, refresh: String) async throws -> String?
  /// Records that the gateway named `personKey`'s person as the one whose token is `access`, and
  /// says whether the kept sign-in now names them. It records only while the sign-in still holds
  /// `access` and names nobody, and never overwrites another person; a sign-in that already names
  /// them is true too.
  func recordPersonKey(holding access: String, _ personKey: String) async throws -> Bool
  func forget() async throws
}
public final class MemorySignIn: SignInKept {
  private let value: Mutex<HeldSignIn?>
  public init(_ signIn: HeldSignIn? = nil) { value = Mutex(signIn) }
  public func held() async -> HeldSignIn? { value.withLock { $0 } }
  public func keep(_ signIn: HeldSignIn) async { value.withLock { $0 = signIn } }
  public func renewed(read: HeldSignIn, access: String, refresh: String) async -> String? {
    value.withLock { held in
      guard var current = held else { return nil }
      guard current.access == read.access && current.refresh == read.refresh else {
        return current.access
      }
      current.access = access
      current.refresh = refresh
      held = current
      return access
    }
  }
  public func recordPersonKey(holding access: String, _ personKey: String) async -> Bool {
    value.withLock { held in
      guard var current = held, current.access == access else { return false }
      guard current.personKey == nil else { return current.personKey == personKey }
      current.personKey = personKey
      held = current
      return true
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
