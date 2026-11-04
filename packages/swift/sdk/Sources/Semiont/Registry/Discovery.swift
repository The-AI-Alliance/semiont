import AsyncHTTPClient
import Foundation

public let discoveryInterval: Duration = .milliseconds(Timings.discoveryIntervalMs)

public enum DiscoveryAbsentReason: String, Codable, CaseIterable, Sendable {
  case notFound = "not-found"
  case notJSON = "not-json"
  case invalid
  case unsupportedVersion = "unsupported-version"
  case unreadable
}

public struct Absent: Sendable {
  public let reason: DiscoveryAbsentReason
  public let diagnostic: String?

  public init(reason: DiscoveryAbsentReason, diagnostic: String? = nil) {
    self.reason = reason
    self.diagnostic = diagnostic
  }
}

public struct Managed: Sendable {
  public let kbs: [DiscoveredKB]

  public init(kbs: [DiscoveredKB]) { self.kbs = kbs }
}

public struct Unchanged: Sendable {
  public init() {}
}

public enum DiscoveryState: Sendable {
  case absent(Absent)
  case managed(Managed)
}

public enum DiscoveryRead: Sendable {
  case state(DiscoveryState)
  case unchanged(Unchanged)
}

public protocol DiscoveryTransport: Sendable {
  func read() async -> DiscoveryRead
}

public func parseDiscoveryDocument(_ text: String) -> DiscoveryState {
  let data = Data(text.utf8)
  let decoder = JSONDecoder()
  let parsed: JSONValue
  do {
    parsed = try decoder.decode(JSONValue.self, from: data)
  } catch {
    return .absent(Absent(reason: .notJSON, diagnostic: String(describing: error)))
  }
  guard case .object(let fields) = parsed,
    case .number(let version) = fields["version"], version.rounded() == version
  else {
    return .absent(Absent(reason: .invalid, diagnostic: "Missing a numeric discovery version"))
  }
  guard let encodedVersion = try? JSONEncoder().encode(version),
    (try? decoder.decode(DiscoveryDocumentVersion.self, from: encodedVersion)) != nil
  else {
    return .absent(
      Absent(reason: .unsupportedVersion, diagnostic: "Unsupported discovery version \(version)"))
  }
  do {
    let document = try decoder.decode(DiscoveryDocument.self, from: data)
    guard document.kbs.allSatisfy({ !$0.host.isEmpty && (1...65535).contains($0.port) }) else {
      return .absent(Absent(reason: .invalid, diagnostic: "Invalid knowledge-base address"))
    }
    return .managed(Managed(kbs: document.kbs))
  } catch {
    return .absent(Absent(reason: .invalid, diagnostic: String(describing: error)))
  }
}

private struct TextDiscovery: DiscoveryTransport {
  let text: @Sendable () async throws -> String

  func read() async -> DiscoveryRead {
    do {
      return .state(parseDiscoveryDocument(try await text()))
    } catch let error as CocoaError
      where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile
    {
      return .state(.absent(Absent(reason: .notFound)))
    } catch {
      return .state(.absent(Absent(reason: .unreadable, diagnostic: String(describing: error))))
    }
  }
}

public func textDiscovery(_ read: @escaping @Sendable () async throws -> String)
  -> any DiscoveryTransport
{
  TextDiscovery(text: read)
}

private actor HTTPDiscovery: DiscoveryTransport {
  let url: String
  let http: HTTPClient
  var tag: String?

  init(url: String, http: HTTPClient) {
    self.url = url
    self.http = http
  }

  func read() async -> DiscoveryRead {
    var request = HTTPClientRequest(url: url)
    if let tag { request.headers.add(name: "If-None-Match", value: tag) }
    do {
      let http = http
      let (state, etag) = try await within(Timings.httpRequestTimeoutMs) { [request] in
        let response = try await http.execute(request, deadline: .distantFuture)
        if response.status.code == 304 {
          return (DiscoveryRead.unchanged(Unchanged()), nil as String?)
        }
        guard (200..<300).contains(response.status.code),
          response.headers.first(name: "Content-Type")?.lowercased().contains("json") == true
        else {
          return (
            .state(.absent(Absent(reason: .notFound, diagnostic: "HTTP \(response.status.code)"))),
            nil
          )
        }
        var data = Data()
        for try await chunk in response.body { data.append(contentsOf: chunk.readableBytesView) }
        return (
          .state(parseDiscoveryDocument(String(decoding: data, as: UTF8.self))),
          response.headers.first(name: "ETag")
        )
      }
      if case .state(.managed) = state { tag = etag }
      return state
    } catch {
      return .state(.absent(Absent(reason: .unreadable, diagnostic: String(describing: error))))
    }
  }
}

public func httpDiscovery(_ url: String, httpClient: HTTPClient) -> any DiscoveryTransport {
  HTTPDiscovery(url: url, http: httpClient)
}

public struct DiscoveryDiff: Sendable {
  public let state: DiscoveryState
  public let added: [DiscoveredKB]
  public let updated: [DiscoveredKB]
  public let removed: [DiscoveredKB]
  public let duplicated: [String]
}

private func address(_ kb: DiscoveredKB) -> String { "\(kb.host):\(kb.port)" }

private func entries(_ state: DiscoveryState?) -> [DiscoveredKB] {
  if case .managed(let managed) = state { return managed.kbs }
  return []
}

private func reason(_ state: DiscoveryState?) -> DiscoveryAbsentReason? {
  if case .absent(let absent) = state { return absent.reason }
  return nil
}

private func discoveryDiff(from previous: DiscoveryState?, to next: DiscoveryState)
  -> DiscoveryDiff?
{
  let before = entries(previous)
  let after = entries(next)
  let was = Dictionary(grouping: before, by: address)
  let now = Dictionary(grouping: after, by: address)
  let added = after.filter { was[address($0)] == nil }
  let removed = before.filter { now[address($0)] == nil }
  let updated = after.filter { kb in
    guard let previous = was[address(kb)] else { return false }
    let value = try? wirePayload(kb)
    return !previous.contains { (try? wirePayload($0)) == value }
  }
  var seen: Set<String> = []
  let duplicates = after.map(address).filter {
    (now[$0]?.count ?? 0) > 1 && seen.insert($0).inserted
  }
  let changedDuplicates = Set(was.filter { $0.value.count > 1 }.keys) != Set(duplicates)
  guard
    previous == nil || reason(previous) != reason(next) || changedDuplicates
      || !added.isEmpty || !removed.isEmpty || !updated.isEmpty
  else { return nil }
  return DiscoveryDiff(
    state: next, added: added, updated: updated, removed: removed, duplicated: duplicates)
}

private actor DiscoveryWatcher {
  let transport: any DiscoveryTransport
  let interval: Duration
  var last: DiscoveryState?
  var readOnce = false

  init(transport: any DiscoveryTransport, interval: Duration) {
    self.transport = transport
    self.interval = interval
  }

  func next() async -> DiscoveryDiff? {
    while !Task.isCancelled {
      if readOnce {
        do { try await Task.sleep(for: interval) } catch { return nil }
      }
      readOnce = true
      if case .state(let state) = await transport.read(), !Task.isCancelled,
        let changed = discoveryDiff(from: last, to: state)
      {
        last = state
        return changed
      }
    }
    return nil
  }
}

public func subscribeDiscovery(
  _ transport: any DiscoveryTransport, interval: Duration = discoveryInterval
) -> AsyncStream<DiscoveryDiff> {
  let watcher = DiscoveryWatcher(transport: transport, interval: interval)
  return AsyncStream(unfolding: { await watcher.next() })
}
