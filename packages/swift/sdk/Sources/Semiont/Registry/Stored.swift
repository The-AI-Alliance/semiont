import Foundation
import Synchronization

public let knowledgeBasesKey = "semiont.knowledgeBases"
public let activeKey = "semiont.activeKnowledgeBaseId"
public let openResourcesByKbKey = "semiont.openResourcesByKb"
public let lastViewedResourceByKbKey = "semiont.lastViewedResourceByKb"
public let pendingAuthorizationKey = "semiont.pendingAuthorization"
private let sessionPrefix = "semiont.session."

public func sessionKey(_ kbId: String) -> String { sessionPrefix + kbId }

public func kbOfSessionKey(_ key: String) -> String? {
  guard key.hasPrefix(sessionPrefix) else { return nil }
  return String(key.dropFirst(sessionPrefix.count))
}

func storedText<Value: Encodable>(_ value: Value) throws -> String {
  String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
}

func decodedStorage<Value: Decodable>(_ type: Value.Type, _ text: String?) -> Value? {
  guard let text else { return nil }
  return try? JSONDecoder().decode(type, from: Data(text.utf8))
}

public func storedSession(_ storage: any SessionStorage, kbId: String) throws -> HeldSignIn? {
  decodedStorage(HeldSignIn.self, try storage.get(sessionKey(kbId)))
}

public func storeSession(
  _ storage: any SessionStorage, kbId: String, session: HeldSignIn
) throws {
  try storage.set(sessionKey(kbId), storedText(session))
}

public func clearStoredSession(_ storage: any SessionStorage, kbId: String) throws {
  try storage.delete(sessionKey(kbId))
}

func readKnowledgeBases(_ text: String?) -> [KnowledgeBase] {
  let entries = decodedStorage([JSONValue].self, text) ?? []
  return entries.compactMap { entry in
    guard let data = try? JSONEncoder().encode(entry) else { return nil }
    return try? JSONDecoder().decode(KnowledgeBase.self, from: data)
  }
}

public func loadKnowledgeBases(_ storage: any SessionStorage) throws -> [KnowledgeBase] {
  readKnowledgeBases(try storage.get(knowledgeBasesKey))
}

public func saveKnowledgeBases(
  _ storage: any SessionStorage, knowledgeBases: [KnowledgeBase]
) throws {
  try storage.set(knowledgeBasesKey, storedText(knowledgeBases))
}

private struct RegistryKept: SignInKept {
  let storage: any SessionStorage
  let kbId: String

  func held() async throws -> HeldSignIn? { try storedSession(storage, kbId: kbId) }
  func keep(_ signIn: HeldSignIn) async throws {
    try storeSession(storage, kbId: kbId, session: signIn)
  }
  func forget() async throws { try clearStoredSession(storage, kbId: kbId) }

  func renewed(read: HeldSignIn, access: String, refresh: String) async throws -> String? {
    let answer = Mutex<String?>(nil)
    try storage.update(sessionKey(kbId)) { text in
      guard let current = decodedStorage(HeldSignIn.self, text) else { return text }
      guard current.access == read.access, current.refresh == read.refresh else {
        answer.withLock { $0 = current.access }
        return text
      }
      let next = HeldSignIn(
        access: access, clientId: current.clientId, refresh: refresh,
        revocationEndpoint: current.revocationEndpoint, tokenEndpoint: current.tokenEndpoint)
      let written = try storedText(next)
      answer.withLock { $0 = access }
      return written
    }
    return answer.withLock { $0 }
  }
}

public func keptIn(_ storage: any SessionStorage, kbId: String) -> any SignInKept {
  RegistryKept(storage: storage, kbId: kbId)
}
