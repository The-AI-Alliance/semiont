import Crypto
import Foundation
import Synchronization

public let knowledgeBasesKey = "semiont.knowledgeBases"
public let activeKey = "semiont.activeKnowledgeBaseId"
public let openResourcesByKbKey = "semiont.openResourcesByKb"
public let lastViewedResourceByKbKey = "semiont.lastViewedResourceByKb"
public let pendingAuthorizationKey = "semiont.pendingAuthorization"
private let sessionPrefix = "semiont.session."
let cacheKeyPrefix = "semiont.cache."
let lastEventIdKeyPrefix = "semiont.lastEventId."

public func sessionKey(_ kbId: String) -> String { sessionPrefix + kbId }

/// The key a person's caches and stream places are kept under: the unpadded base64url SHA-256 of
/// the UTF-8 of their did, never the did itself.
public func personKey(_ did: UserId) -> String {
  base64URL(Data(SHA256.hash(data: Data(did.value.utf8))))
}

func lastEventIdKey(_ kbId: String, _ personKey: String) -> String {
  "\(lastEventIdKeyPrefix)\(kbId).\(personKey)"
}

func cacheKey(_ kbId: String, _ personKey: String, _ query: KeptQuery) -> String {
  "\(cacheKeyPrefix)\(kbId).\(personKey).\(query.rawValue)"
}

/// Deletes what every client kept of the person `personKey` on the knowledge base `kbId`: each
/// persisted query's document and the stream's places. Forgetting a saved sign-in deletes them for
/// the person it named.
func forgetKept(_ storage: any SessionStorage, kbId: String, personKey: String) throws {
  for query in KeptQuery.allCases { try storage.delete(cacheKey(kbId, personKey, query)) }
  try storage.delete(lastEventIdKey(kbId, personKey))
}

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

/// Forgets the knowledge base `kbId`'s saved sign-in, and what every client kept there of the
/// person it named.
public func clearStoredSession(_ storage: any SessionStorage, kbId: String) throws {
  if let person = try takeStoredSession(storage, kbId: kbId)?.personKey {
    try forgetKept(storage, kbId: kbId, personKey: person)
  }
}

/// Clears the knowledge base `kbId`'s stored sign-in in one update, and gives what it held: the
/// person whose keys forgetting it deletes.
func takeStoredSession(_ storage: any SessionStorage, kbId: String) throws -> HeldSignIn? {
  let taken = Mutex<String?>(nil)
  try storage.update(sessionKey(kbId)) { text in
    taken.withLock { $0 = text }
    return nil
  }
  return decodedStorage(HeldSignIn.self, taken.withLock { $0 })
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

/// The sign-in a registry keeps in `storage` for the knowledge base `kbId`.
struct RegistryKept: SignInKept {
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
      var next = current
      next.access = access
      next.refresh = refresh
      let written = try storedText(next)
      answer.withLock { $0 = access }
      return written
    }
    return answer.withLock { $0 }
  }

  func recordPersonKey(holding access: String, _ personKey: String) async throws -> Bool {
    let recorded = Mutex(false)
    try storage.update(sessionKey(kbId)) { text in
      guard var current = decodedStorage(HeldSignIn.self, text), current.access == access else {
        return text
      }
      guard current.personKey == nil else {
        recorded.withLock { $0 = current.personKey == personKey }
        return text
      }
      current.personKey = personKey
      let written = try storedText(current)
      recorded.withLock { $0 = true }
      return written
    }
    return recorded.withLock { $0 }
  }
}

public func keptIn(_ storage: any SessionStorage, kbId: String) -> any SignInKept {
  RegistryKept(storage: storage, kbId: kbId)
}
